//! IPC HCI Transport and high-level BLE Controller.

use bt_hci::transport::{Transport, WithIndicator};
use bt_hci::{ControllerToHostPacket, HostToControllerPacket, ReadHci, ReadHciError, WriteHci};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::mutex::Mutex;
use embedded_io::ReadExactError;

use sifli_hal::ipc::{Error as IpcError, IpcQueue, IpcQueueRx, IpcQueueTx};

#[cfg(any(feature = "defmt", feature = "log"))]
struct LoggingReader<'a> {
    inner: &'a mut IpcQueueRx,
    log: [u8; 64],
    pos: usize,
}

#[cfg(any(feature = "defmt", feature = "log"))]
impl<'a> LoggingReader<'a> {
    fn new(inner: &'a mut IpcQueueRx) -> Self {
        Self {
            inner,
            log: [0; 64],
            pos: 0,
        }
    }

    fn dump(&self, prefix: &str) {
        let end = self.pos.min(64);
        debug!(
            "[hci] {} ({} bytes): {:x}",
            prefix,
            self.pos,
            crate::fmt::Bytes(&self.log[..end])
        );
    }
}

#[cfg(any(feature = "defmt", feature = "log"))]
impl embedded_io::ErrorType for LoggingReader<'_> {
    type Error = IpcError;
}

#[cfg(any(feature = "defmt", feature = "log"))]
impl embedded_io_async::Read for LoggingReader<'_> {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, Self::Error> {
        let n = embedded_io_async::Read::read(self.inner, buf).await?;
        let copy_end = (self.pos + n).min(64);
        if self.pos < 64 {
            let copy_n = copy_end - self.pos;
            self.log[self.pos..copy_end].copy_from_slice(&buf[..copy_n]);
        }
        self.pos += n;
        Ok(n)
    }
}

/// bt-hci Transport error type.
#[derive(Debug)]
pub enum HciError {
    /// IPC read error.
    Read(ReadHciError<IpcError>),
    /// IPC write error.
    Write(IpcError),
}

#[cfg(feature = "defmt")]
impl defmt::Format for HciError {
    fn format(&self, f: defmt::Formatter) {
        match self {
            HciError::Read(e) => defmt::write!(f, "HCI read error: {:?}", defmt::Debug2Format(e)),
            HciError::Write(e) => defmt::write!(f, "HCI write error: {}", e),
        }
    }
}

impl core::fmt::Display for HciError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            HciError::Read(e) => write!(f, "HCI read error: {:?}", e),
            HciError::Write(e) => write!(f, "HCI write error: {}", e),
        }
    }
}

impl core::error::Error for HciError {}

impl embedded_io::Error for HciError {
    fn kind(&self) -> embedded_io::ErrorKind {
        match self {
            Self::Read(e) => e.kind(),
            Self::Write(e) => e.kind(),
        }
    }
}

impl From<IpcError> for HciError {
    fn from(e: IpcError) -> Self {
        Self::Write(e)
    }
}

impl From<ReadHciError<IpcError>> for HciError {
    fn from(e: ReadHciError<IpcError>) -> Self {
        Self::Read(e)
    }
}

impl From<ReadExactError<IpcError>> for HciError {
    fn from(e: ReadExactError<IpcError>) -> Self {
        Self::Read(e.into())
    }
}

impl From<bt_hci::FromHciBytesError> for HciError {
    fn from(e: bt_hci::FromHciBytesError) -> Self {
        Self::Read(e.into())
    }
}

/// IPC HCI Transport, wrapping [`IpcQueue`] as a bt-hci Transport.
pub struct IpcHciTransport {
    rx: Mutex<CriticalSectionRawMutex, IpcQueueRx>,
    tx: Mutex<CriticalSectionRawMutex, (IpcQueueTx, [u8; sifli_hal::ipc::HCI_PACKET_CAPACITY])>,
}

impl IpcHciTransport {
    /// Create a new IPC HCI Transport.
    pub fn new(queue: IpcQueue) -> Self {
        let (rx, tx) = queue.split();
        Self::from_parts(rx, tx)
    }

    /// Create Transport from pre-split RX/TX halves.
    pub fn from_parts(rx: IpcQueueRx, tx: IpcQueueTx) -> Self {
        Self {
            rx: Mutex::new(rx),
            tx: Mutex::new((tx, [0; sifli_hal::ipc::HCI_PACKET_CAPACITY])),
        }
    }
}

impl embedded_io::ErrorType for IpcHciTransport {
    type Error = HciError;
}

impl Transport for IpcHciTransport {
    async fn read<'a>(&self, rx: &'a mut [u8]) -> Result<ControllerToHostPacket<'a>, Self::Error> {
        let mut q = self.rx.lock().await;

        #[cfg(any(feature = "defmt", feature = "log"))]
        {
            let mut logging_rx = LoggingReader::new(&mut *q);
            let pkt = ControllerToHostPacket::read_hci_async(&mut logging_rx, rx)
                .await
                .map_err(HciError::Read)?;
            logging_rx.dump("rx");
            Ok(pkt)
        }

        #[cfg(not(any(feature = "defmt", feature = "log")))]
        {
            ControllerToHostPacket::read_hci_async(&mut *q, rx)
                .await
                .map_err(HciError::Read)
        }
    }

    async fn write<T: HostToControllerPacket>(&self, val: &T) -> Result<(), Self::Error> {
        let mut guard = self.tx.lock().await;
        let (queue, scratch) = &mut *guard;
        let mut output = scratch.as_mut_slice();
        WithIndicator::new(val)
            .write_hci(&mut output)
            .map_err(|_| HciError::Write(IpcError::BufferTooSmall))?;
        let len = sifli_hal::ipc::HCI_PACKET_CAPACITY - output.len();
        let packet = &scratch[..len];
        #[cfg(any(feature = "defmt", feature = "log"))]
        debug!("[hci] tx {} bytes: {:x}", len, crate::fmt::Bytes(&packet[..len.min(64)]));
        queue.send_packet(packet).await?;
        Ok(())
    }
}

/// Consume the BT warmup event from IPC HCI RX.
pub(crate) async fn consume_warmup_event<R>(rx: &mut R) -> Result<(), sifli_hal::lcpu::LcpuError>
where
    R: embedded_io_async::Read,
{
    let mut header = [0u8; 3];
    rx.read_exact(&mut header)
        .await
        .map_err(|_| sifli_hal::lcpu::LcpuError::WarmupReadError)?;

    if header[0] != 0x04 {
        warn!(
            "[hci] unexpected H4 indicator in warmup: 0x{:02X}, expected 0x04",
            header[0]
        );
    }

    let param_len = header[2] as usize;
    if param_len > 0 {
        let mut params = [0u8; 255];
        rx.read_exact(&mut params[..param_len])
            .await
            .map_err(|_| sifli_hal::lcpu::LcpuError::WarmupReadError)?;
    }

    Ok(())
}

