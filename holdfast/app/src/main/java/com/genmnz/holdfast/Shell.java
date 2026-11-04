package com.genmnz.holdfast;

import android.content.ComponentName;
import android.content.Context;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import rikka.shizuku.Shizuku;

/** Optional shell tier through Shizuku (or a compatible fork). Never call on the main thread. */
final class Shell {
    static final class Result {
        final int exit;
        final String out;

        Result(int exit, String out) {
            this.exit = exit;
            this.out = out;
        }
    }

    private static volatile IShell service;

    private Shell() {}

    static boolean binder() {
        try {
            return Shizuku.pingBinder();
        } catch (Throwable t) {
            return false;
        }
    }

    static boolean permitted() {
        try {
            return binder() && !Shizuku.isPreV11()
                    && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    static String describe() {
        if (!binder()) return "not running";
        try {
            String who = Shizuku.getUid() == 0 ? "root" : Shizuku.getUid() == 2000 ? "shell" : "uid " + Shizuku.getUid();
            return "running, API " + Shizuku.getVersion() + " as " + who
                    + (permitted() ? ", permission granted" : ", permission NOT granted");
        } catch (Throwable t) {
            return "running, state unreadable: " + t.getMessage();
        }
    }

    static Result run(Context c, String cmd) throws Exception {
        if (!permitted()) throw new Exception("Shizuku is not running or Holdfast has no Shizuku permission");
        String raw = bind(c).run(cmd);
        int nl = raw.indexOf('\n');
        int exit = Integer.parseInt(raw.substring(5, nl < 0 ? raw.length() : nl));
        return new Result(exit, nl < 0 ? "" : raw.substring(nl + 1));
    }

    private static IShell bind(Context c) throws Exception {
        IShell s = service;
        if (s != null && s.asBinder().pingBinder()) return s;
        CountDownLatch done = new CountDownLatch(1);
        ServiceConnection conn = new ServiceConnection() {
            @Override
            public void onServiceConnected(ComponentName name, IBinder binder) {
                if (binder != null && binder.pingBinder()) service = IShell.Stub.asInterface(binder);
                done.countDown();
            }

            @Override
            public void onServiceDisconnected(ComponentName name) {
                service = null;
            }
        };
        Shizuku.UserServiceArgs args = new Shizuku.UserServiceArgs(
                new ComponentName(c.getPackageName(), ShellService.class.getName()))
                .daemon(false)
                .processNameSuffix("shell")
                .debuggable(BuildConfig.DEBUG)
                .version(BuildConfig.VERSION_CODE);
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Shizuku.bindUserService(args, conn);
            } catch (Throwable t) {
                done.countDown();
            }
        });
        if (!done.await(10, TimeUnit.SECONDS)) throw new Exception("Shizuku shell service didn't start within 10 s");
        if (service == null) throw new Exception("Shizuku refused to start the shell service");
        return service;
    }
}
