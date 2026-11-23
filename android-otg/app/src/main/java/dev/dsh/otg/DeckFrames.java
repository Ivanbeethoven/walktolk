package dev.dsh.otg;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

final class DeckFrames {
    static final int REPORT_SIZE = 64;
    static final int REPORT_ID = 6;
    private static final int CHANNEL = 5;
    private final ByteArrayOutputStream pending = new ByteArrayOutputStream();
    private boolean oversize;

    static byte[] hello(long sid) {
        if (sid < 1 || sid > 0xffffffffL) throw new IllegalArgumentException("sid");
        String line = "{\"m\":\"hello\",\"v\":1,\"sid\":" + sid + "}\n";
        byte[] payload = line.getBytes(StandardCharsets.UTF_8);
        byte[] report = new byte[REPORT_SIZE];
        report[0] = REPORT_ID;
        report[1] = CHANNEL;
        report[2] = (byte) payload.length;
        System.arraycopy(payload, 0, report, 3, payload.length);
        return report;
    }

    List<String> accept(byte[] report, int count) {
        List<String> lines = new ArrayList<>();
        if (report == null || count < 3 || count > REPORT_SIZE || count > report.length
                || report[0] != REPORT_ID || report[1] != CHANNEL) return lines;
        int length = report[2] & 0xff;
        if (length > count - 3) return lines;
        for (int index = 3; index < 3 + length; index++) {
            byte next = report[index];
            if (next == '\n') {
                if (!oversize && pending.size() > 0) {
                    lines.add(new String(pending.toByteArray(), StandardCharsets.UTF_8));
                }
                pending.reset();
                oversize = false;
            } else if (!oversize) {
                if (pending.size() < 1023) {
                    pending.write(next);
                } else {
                    pending.reset();
                    oversize = true;
                }
            }
        }
        return lines;
    }
}
