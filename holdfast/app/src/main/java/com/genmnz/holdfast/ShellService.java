package com.genmnz.holdfast;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/** Runs inside Shizuku's process as the shell user. Started by {@link Shell}. */
public class ShellService extends IShell.Stub {
    private static final int MAX_OUT = 64 * 1024;

    public ShellService() {}

    @Override
    public void destroy() {
        System.exit(0);
    }

    @Override
    public String run(String cmd) {
        try {
            Process p = new ProcessBuilder("sh", "-c", cmd).redirectErrorStream(true).start();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            try (InputStream in = p.getInputStream()) {
                byte[] b = new byte[4096];
                int n;
                while ((n = in.read(b)) > 0) {
                    if (buf.size() < MAX_OUT) buf.write(b, 0, Math.min(n, MAX_OUT - buf.size()));
                }
            }
            return "exit=" + p.waitFor() + "\n" + buf.toString("UTF-8");
        } catch (Exception e) {
            return "exit=127\n" + e;
        }
    }
}
