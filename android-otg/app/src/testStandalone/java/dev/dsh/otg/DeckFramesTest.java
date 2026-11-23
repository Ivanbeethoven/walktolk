package dev.dsh.otg;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Standalone, dependency-free checks for DeckFrames. */
public final class DeckFramesTest {
    private static int checks;

    private DeckFramesTest() {}

    public static void main(String[] args) {
        helloIsAZeroPaddedChannelFiveReport();
        linesSurviveArbitraryChunksAndSplitUtf8();
        lineLimitIncludesTheLineFeed();
        malformedAndTruncatedReportsAreIgnored();
        initialSidZeroResponseIsReturnedByTheFramer();
        System.out.println("DeckFramesTest: " + checks + " checks passed");
    }

    private static void helloIsAZeroPaddedChannelFiveReport() {
        String line = "{\"m\":\"hello\",\"v\":1,\"sid\":42}\n";
        byte[] payload = line.getBytes(StandardCharsets.UTF_8);
        byte[] expected = new byte[64];
        expected[0] = 6;
        expected[1] = 5;
        expected[2] = (byte) payload.length;
        System.arraycopy(payload, 0, expected, 3, payload.length);
        arrayEquals(expected, DeckFrames.hello(42L), "hello frame bytes and zero padding");
    }

    private static void linesSurviveArbitraryChunksAndSplitUtf8() {
        String first = "{\"m\":\"" + "x".repeat(53) + "中\",\"sid\":0}";
        String second = "{\"m\":\"reply\",\"text\":\"你好\"}";
        byte[] stream = (first + "\n" + second + "\n").getBytes(StandardCharsets.UTF_8);
        DeckFrames frames = new DeckFrames();
        List<String> actual = feed(frames, stream, 60, 1, 61);
        listEquals(Arrays.asList(first, second), actual,
                "concatenated lines, arbitrary report splits, split UTF-8 character");
    }

    private static void lineLimitIncludesTheLineFeed() {
        DeckFrames frames = new DeckFrames();
        String atLimit = "{\"m\":\"" + "x".repeat(1015) + "\"}";
        byte[] exactAndNext = (atLimit + "\n{\"m\":\"after-limit\"}\n")
                .getBytes(StandardCharsets.UTF_8);
        equal(1024, (atLimit + "\n").getBytes(StandardCharsets.UTF_8).length,
                "constructed line is exactly 1024 UTF-8 bytes including LF");
        List<String> accepted = feed(frames, exactAndNext, 61);
        listEquals(Arrays.asList(atLimit, "{\"m\":\"after-limit\"}"), accepted,
                "line at the byte limit and following line are accepted");

        String tooLong = "{\"m\":\"" + "y".repeat(1016) + "\"}";
        byte[] oversizedAndNext = (tooLong + "\n{\"m\":\"recovered\"}\n")
                .getBytes(StandardCharsets.UTF_8);
        equal(1025, (tooLong + "\n").getBytes(StandardCharsets.UTF_8).length,
                "constructed oversized line is 1025 UTF-8 bytes including LF");
        listEquals(List.of("{\"m\":\"recovered\"}"), feed(frames, oversizedAndNext, 61),
                "oversized line is discarded through LF and framing recovers");
    }

    private static void malformedAndTruncatedReportsAreIgnored() {
        DeckFrames frames = new DeckFrames();
        byte[] complete = report("{\"m\":\"ignored\"}\n".getBytes(StandardCharsets.UTF_8));

        byte[] wrongId = complete.clone();
        wrongId[0] = 7;
        listEquals(List.of(), frames.accept(wrongId, wrongId.length), "wrong report id ignored");

        byte[] wrongChannel = complete.clone();
        wrongChannel[1] = 4;
        listEquals(List.of(), frames.accept(wrongChannel, wrongChannel.length), "wrong channel ignored");

        listEquals(List.of(), frames.accept(new byte[] { 6, 5 }, 2), "short header ignored");
        listEquals(List.of(), frames.accept(complete, complete.length + 1), "count beyond buffer ignored");

        byte[] impossibleLength = new byte[64];
        impossibleLength[0] = 6;
        impossibleLength[1] = 5;
        impossibleLength[2] = 62;
        listEquals(List.of(), frames.accept(impossibleLength, 64), "payload beyond report capacity ignored");

        byte[] truncated = report("z\n".getBytes(StandardCharsets.UTF_8));
        truncated[2] = 2;
        listEquals(List.of(), frames.accept(truncated, 4), "declared payload longer than transferred bytes ignored");

        listEquals(List.of("{\"m\":\"after-malformed\"}"),
                feed(frames, "{\"m\":\"after-malformed\"}\n".getBytes(StandardCharsets.UTF_8), 61),
                "valid line accepted after malformed reports");
    }

    private static void initialSidZeroResponseIsReturnedByTheFramer() {
        String response = "{\"m\":\"hello\",\"v\":1,\"sid\":0}";
        listEquals(List.of(response), feed(new DeckFrames(), (response + "\n").getBytes(StandardCharsets.UTF_8), 61),
                "sid zero response is preserved as a framed line");
    }

    private static List<String> feed(DeckFrames frames, byte[] data, int... chunkSizes) {
        List<String> lines = new ArrayList<>();
        int offset = 0;
        int chunkIndex = 0;
        while (offset < data.length) {
            int requested = chunkSizes[Math.min(chunkIndex, chunkSizes.length - 1)];
            int length = Math.min(requested, data.length - offset);
            byte[] report = new byte[64];
            report[0] = 6;
            report[1] = 5;
            report[2] = (byte) length;
            System.arraycopy(data, offset, report, 3, length);
            lines.addAll(frames.accept(report, report.length));
            offset += length;
            chunkIndex++;
        }
        return lines;
    }

    private static byte[] report(byte[] payload) {
        if (payload.length > 61) throw new IllegalArgumentException("payload exceeds one report");
        byte[] report = new byte[64];
        report[0] = 6;
        report[1] = 5;
        report[2] = (byte) payload.length;
        System.arraycopy(payload, 0, report, 3, payload.length);
        return report;
    }

    private static void equal(Object expected, Object actual, String label) {
        checks++;
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(label + ": expected <" + expected + ">, got <" + actual + ">");
        }
    }

    private static void arrayEquals(byte[] expected, byte[] actual, String label) {
        checks++;
        if (!Arrays.equals(expected, actual)) {
            throw new AssertionError(label + ": byte arrays differ");
        }
    }

    private static void listEquals(List<String> expected, List<String> actual, String label) {
        checks++;
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected <" + expected + ">, got <" + actual + ">");
        }
    }
}


