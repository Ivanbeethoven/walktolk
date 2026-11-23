#![allow(dead_code)]

#[path = "../../vendor/sifli-rs/sifli-hal/src/ipc/circular_buf.rs"]
mod circular_buf;

use circular_buf::{CircularBuf, CircularBufMutPtrExt, CircularBufPtrExt};
use core::ptr;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Snapshot {
    read_cursor: u32,
    write_cursor: u32,
    data_len: usize,
    space_len: usize,
}

struct RingHarness {
    descriptor: CircularBuf,
    _storage: Vec<u8>,
}

impl RingHarness {
    fn new(size: usize) -> Self {
        assert!(size > 0);
        assert!(size <= i16::MAX as usize);
        assert_eq!(size % 4, 0);

        let mut storage = vec![0_u8; size];
        let mut descriptor = CircularBuf {
            rd_buffer_ptr: ptr::null_mut(),
            wr_buffer_ptr: ptr::null_mut(),
            read_idx_mirror: 0,
            write_idx_mirror: 0,
            buffer_size: 0,
        };
        let descriptor_ptr = &mut descriptor as *mut CircularBuf;
        unsafe {
            descriptor_ptr.wr_init(storage.as_mut_ptr(), size as i16);
            descriptor_ptr.rd_init(storage.as_mut_ptr());
        }

        Self {
            descriptor,
            _storage: storage,
        }
    }

    fn write(&mut self, data: &[u8], whole: bool) -> usize {
        let descriptor_ptr = &mut self.descriptor as *mut CircularBuf;
        unsafe { descriptor_ptr.put(data, whole) }
    }

    fn read(&mut self, out: &mut [u8]) -> usize {
        let descriptor_ptr = &mut self.descriptor as *mut CircularBuf;
        unsafe { descriptor_ptr.get(out) }
    }

    fn snapshot(&self) -> Snapshot {
        let descriptor_ptr = &self.descriptor as *const CircularBuf;
        unsafe {
            Snapshot {
                read_cursor: descriptor_ptr.read_idx_mirror(),
                write_cursor: descriptor_ptr.write_idx_mirror(),
                data_len: descriptor_ptr.data_len(),
                space_len: descriptor_ptr.space_len(),
            }
        }
    }
}

#[test]
fn empty_ring_and_single_whole_frame_round_trip_exactly() {
    let mut ring = RingHarness::new(16);
    let empty = Snapshot {
        read_cursor: 0,
        write_cursor: 0,
        data_len: 0,
        space_len: 16,
    };

    assert_eq!(ring.snapshot(), empty);
    assert_eq!(ring.write(&[], true), 0);
    assert_eq!(ring.snapshot(), empty);

    let frame = [0x21, 0x00, 0xFE, 0x7A, 0x44];
    assert_eq!(ring.write(&frame, true), frame.len());
    let queued = ring.snapshot();
    assert_eq!(queued.data_len, frame.len());
    assert_eq!(queued.space_len, 16 - frame.len());

    let mut out = [0_u8; 8];
    assert_eq!(ring.read(&mut out), frame.len());
    assert_eq!(&out[..frame.len()], &frame);
    assert_eq!(ring.snapshot().data_len, 0);
    assert_eq!(ring.snapshot().space_len, 16);
}

#[test]
fn stream_writes_keep_the_existing_partial_capacity_semantics() {
    let mut ring = RingHarness::new(8);
    let first = [0x10, 0x11, 0x12, 0x13, 0x14, 0x15];
    let second = [0x20, 0x21, 0x22, 0x23];

    assert_eq!(ring.write(&first, false), first.len());
    assert_eq!(ring.write(&second, false), 2);
    assert_eq!(ring.snapshot().data_len, 8);
    assert_eq!(ring.write(&[0x30], false), 0);

    let mut out = [0_u8; 10];
    assert_eq!(ring.read(&mut out), 8);
    let mut expected = first.to_vec();
    expected.extend_from_slice(&second[..2]);
    assert_eq!(&out[..8], expected);
    assert_eq!(ring.snapshot().data_len, 0);
}

#[test]
fn whole_short_write_stays_unpublished_then_retries_in_order_across_wrap() {
    let mut ring = RingHarness::new(8);
    let prefix = [0x10, 0x11, 0x12, 0x13, 0x14, 0x15];
    let packet = [0xA1, 0xA2, 0xA3, 0xA4];
    let tail = [0xB1, 0xB2, 0xB3, 0xB4];

    assert_eq!(ring.write(&prefix, true), prefix.len());
    let mut first = [0_u8; 1];
    assert_eq!(ring.read(&mut first), 1);
    assert_eq!(first[0], prefix[0]);

    let before_short_write = ring.snapshot();
    assert_eq!(before_short_write.data_len, 5);
    assert_eq!(before_short_write.space_len, 3);
    assert_eq!(ring.write(&packet, true), 0);
    assert_eq!(ring.snapshot(), before_short_write);

    let mut pending = [0_u8; 5];
    assert_eq!(ring.read(&mut pending), pending.len());
    assert_eq!(&pending, &prefix[1..]);
    assert_eq!(ring.snapshot().data_len, 0);

    assert_eq!(ring.write(&packet, true), packet.len());
    assert_eq!(ring.write(&tail, true), tail.len());
    let full = ring.snapshot();
    assert_eq!(full.data_len, 8);
    assert_eq!(full.space_len, 0);
    assert_eq!(ring.write(&[0xF0], false), 0);
    assert_eq!(ring.snapshot(), full);
    assert_eq!(ring.write(&[0xF1, 0xF2], true), 0);
    assert_eq!(ring.snapshot(), full);

    let mut out = [0_u8; 8];
    assert_eq!(ring.read(&mut out), out.len());
    let mut expected = packet.to_vec();
    expected.extend_from_slice(&tail);
    assert_eq!(out.as_slice(), expected.as_slice());
    assert_eq!(ring.snapshot().data_len, 0);
}

#[test]
fn audio_and_control_bursts_retry_without_loss_across_many_ring_cycles() {
    const RING_CAPACITY: usize = 256;
    // 20 ms at 16 kHz IMA ADPCM: six header bytes plus 320 packed samples.
    const AUDIO_FRAME_LEN: usize = 6 + 320 / 2;
    // One complete 64-byte vendor HID report carrying a control message.
    const CONTROL_REPORT_LEN: usize = 64;
    const DRAIN_CHUNK: usize = 37;

    let mut ring = RingHarness::new(RING_CAPACITY);
    let mut received = Vec::new();
    let mut expected = Vec::new();

    for cycle in 0_u8..6 {
        for (tag, length) in [
            (0x20_u8, AUDIO_FRAME_LEN),
            (0x80_u8, CONTROL_REPORT_LEN),
            (0x40_u8, AUDIO_FRAME_LEN),
            (0xC0_u8, 11),
        ] {
            let frame: Vec<u8> = (0..length)
                .map(|index| {
                    tag.wrapping_add(cycle.wrapping_mul(17))
                        .wrapping_add(index as u8)
                })
                .collect();

            loop {
                let before_attempt = ring.snapshot();
                let written = ring.write(&frame, true);
                if written == frame.len() {
                    break;
                }

                assert_eq!(written, 0, "whole writes must not accept a prefix");
                assert_eq!(ring.snapshot(), before_attempt);
                assert!(before_attempt.data_len > 0, "each frame fits in the ring");

                let count = before_attempt.data_len.min(DRAIN_CHUNK);
                let mut chunk = vec![0_u8; count];
                assert_eq!(ring.read(&mut chunk), count);
                received.extend_from_slice(&chunk);
            }

            expected.extend_from_slice(&frame);
        }
    }

    let mut drain_size = 19;
    while ring.snapshot().data_len > 0 {
        let count = ring.snapshot().data_len.min(drain_size);
        let mut chunk = vec![0_u8; count];
        assert_eq!(ring.read(&mut chunk), count);
        received.extend_from_slice(&chunk);
        drain_size = if drain_size == 79 {
            19
        } else {
            drain_size + 20
        };
    }

    assert_eq!(received, expected);
    assert_eq!(ring.snapshot().data_len, 0);
    assert_eq!(ring.snapshot().space_len, RING_CAPACITY);
}

/// Test-only frame model: H4 type (1), ACL header (4), L2CAP header (4),
/// ATT opcode and handle (3), then the application value. These bytes are
/// simulated; they do not represent a negotiated device capture.
fn simulated_h4_att_packet(att_opcode: u8, att_handle: u16, value: &[u8]) -> Vec<u8> {
    let att_pdu_len = 3 + value.len();
    let acl_data_len = 4 + att_pdu_len;
    let mut packet = Vec::with_capacity(12 + value.len());

    packet.push(0x02); // H4 ACL packet type.
    packet.extend_from_slice(&0x0042_u16.to_le_bytes()); // Simulated connection handle.
    packet.extend_from_slice(&(acl_data_len as u16).to_le_bytes());
    packet.extend_from_slice(&(att_pdu_len as u16).to_le_bytes());
    packet.extend_from_slice(&0x0004_u16.to_le_bytes()); // L2CAP ATT channel.
    packet.push(att_opcode);
    packet.extend_from_slice(&att_handle.to_le_bytes());
    packet.extend_from_slice(value);

    assert_eq!(packet.len(), 12 + value.len());
    packet
}

fn simulated_application_value(kind: u8, cycle: u8, sequence: u8, length: usize) -> Vec<u8> {
    let mut value = vec![0_u8; length];
    if !value.is_empty() {
        value[0] = kind;
    }
    if value.len() > 1 {
        value[1] = cycle;
    }
    if value.len() > 2 {
        value[2] = sequence;
    }
    for (index, byte) in value.iter_mut().enumerate().skip(3) {
        *byte = kind
            .wrapping_add(cycle.wrapping_mul(19))
            .wrapping_add(sequence.wrapping_mul(7))
            .wrapping_add(index as u8);
    }
    value
}

fn simulated_ptt_cycle(cycle: u8) -> Vec<Vec<u8>> {
    const AUDIO_VALUE_LEN: usize = 61;
    const CONTROL_VALUE_LEN: usize = 23;

    let mut packets = Vec::with_capacity(9);
    let start = simulated_application_value(0x01, cycle, 0, 2);
    packets.push(simulated_h4_att_packet(0x12, 0x0040, &start));

    for sequence in 0..6 {
        let audio = simulated_application_value(0x02, cycle, sequence, AUDIO_VALUE_LEN);
        packets.push(simulated_h4_att_packet(0x1B, 0x0042, &audio));
    }

    let control = simulated_application_value(0x11, cycle, 0, CONTROL_VALUE_LEN);
    packets.push(simulated_h4_att_packet(0x12, 0x0040, &control));

    let end = simulated_application_value(0x03, cycle, 0, 2);
    packets.push(simulated_h4_att_packet(0x12, 0x0040, &end));
    packets
}

fn read_chunk(ring: &mut RingHarness, received: &mut Vec<u8>, limit: usize) -> usize {
    let count = ring.snapshot().data_len.min(limit);
    if count == 0 {
        return 0;
    }

    let mut chunk = vec![0_u8; count];
    assert_eq!(ring.read(&mut chunk), count);
    received.extend_from_slice(&chunk);
    count
}

fn send_when_room(
    ring: &mut RingHarness,
    packet: &[u8],
    received: &mut Vec<u8>,
    expected: &mut Vec<u8>,
    next_read_limit: &mut usize,
) {
    loop {
        let before_wait = ring.snapshot();
        let written = ring.write(packet, true);
        if written == packet.len() {
            expected.extend_from_slice(packet);
            return;
        }

        assert_eq!(written, 0, "a whole packet must be accepted or rejected");
        assert_eq!(ring.snapshot(), before_wait);
        assert!(
            before_wait.data_len > 0,
            "every simulated packet fits the ring"
        );

        // Repeated write attempts model timer polls while the peer is not
        // reading. A cancelled send future must leave the queue unchanged.
        for _ in 0..2 {
            assert_eq!(ring.write(packet, true), 0);
            assert_eq!(ring.snapshot(), before_wait);
        }

        let count = read_chunk(ring, received, *next_read_limit);
        assert!(count > 0);
        *next_read_limit = if *next_read_limit >= 101 {
            19
        } else {
            *next_read_limit + 23
        };
    }
}

#[test]
fn real_size_ring_preserves_one_hundred_simulated_ptt_cycles() {
    const RING_CAPACITY: usize = 492;
    const CYCLES: usize = 100;
    const AUDIO_PACKETS_PER_CYCLE: usize = 6;
    const H4_ACL_L2CAP_ATT_OVERHEAD: usize = 12;
    const AUDIO_VALUE_LEN: usize = 61;
    const CONTROL_VALUE_LEN: usize = 23;
    const START_OR_END_VALUE_LEN: usize = 2;
    const PACKETS_PER_CYCLE: usize = 2 + AUDIO_PACKETS_PER_CYCLE + 1;
    const BYTES_PER_CYCLE: usize = 2 * (H4_ACL_L2CAP_ATT_OVERHEAD + START_OR_END_VALUE_LEN)
        + AUDIO_PACKETS_PER_CYCLE * (H4_ACL_L2CAP_ATT_OVERHEAD + AUDIO_VALUE_LEN)
        + H4_ACL_L2CAP_ATT_OVERHEAD
        + CONTROL_VALUE_LEN;

    let mut ring = RingHarness::new(RING_CAPACITY);
    let mut received = Vec::new();
    let mut expected = Vec::new();
    let mut next_read_limit = 19;

    for cycle in 0..CYCLES {
        let packets = simulated_ptt_cycle(cycle as u8);
        assert_eq!(packets.len(), PACKETS_PER_CYCLE);

        for (index, packet) in packets.iter().enumerate() {
            if cycle == 0 && index < PACKETS_PER_CYCLE - 1 {
                // Leave the peer idle through START, six audio notifications,
                // and the control write. Their simulated framed size is 487
                // bytes, leaving less room than the following END packet.
                assert_eq!(ring.write(packet, true), packet.len());
                expected.extend_from_slice(packet);
                continue;
            }

            if cycle == 0 && index == PACKETS_PER_CYCLE - 1 {
                let cancelled_value = simulated_application_value(0x7E, 0, 1, 9);
                let cancelled_packet = simulated_h4_att_packet(0x12, 0x0040, &cancelled_value);
                let before_cancel = ring.snapshot();
                assert_eq!(before_cancel.data_len, 487);
                assert_eq!(before_cancel.space_len, RING_CAPACITY - 487);

                // Three no-read polls model a waiting send future. Dropping
                // this pending control packet must not publish any of it.
                for _ in 0..3 {
                    assert_eq!(ring.write(&cancelled_packet, true), 0);
                    assert_eq!(ring.snapshot(), before_cancel);
                }
                drop(cancelled_packet);
                assert_eq!(ring.snapshot(), before_cancel);

                assert_eq!(read_chunk(&mut ring, &mut received, 31), 31);
            }

            send_when_room(
                &mut ring,
                packet,
                &mut received,
                &mut expected,
                &mut next_read_limit,
            );
        }

        // Keep reads chunked and interleaved with packet writes over repeated
        // cursor and mirror wraps.
        let extra_limit = 29 + (cycle % 5) * 17;
        read_chunk(&mut ring, &mut received, extra_limit);
    }

    let mut final_read_limit = 17;
    while ring.snapshot().data_len > 0 {
        read_chunk(&mut ring, &mut received, final_read_limit);
        final_read_limit = if final_read_limit >= 101 {
            17
        } else {
            final_read_limit + 21
        };
    }

    assert_eq!(expected.len(), CYCLES * BYTES_PER_CYCLE);
    assert_eq!(expected.len(), 50_100);
    assert_eq!(received, expected);
    assert_eq!(ring.snapshot().data_len, 0);
    assert_eq!(ring.snapshot().space_len, RING_CAPACITY);
}
