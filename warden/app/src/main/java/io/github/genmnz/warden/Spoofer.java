package io.github.genmnz.warden;

import android.content.Context;
import android.location.Location;
import android.location.LocationManager;
import android.location.provider.ProviderProperties;
import android.os.Build;
import android.os.Handler;
import android.os.SystemClock;

/**
 * Reports a fixed spot you picked as the phone's location, through Android's
 * mock location API. While it runs, the real GPS/network providers are
 * replaced, so apps only ever see the marked spot.
 *
 * Needs: Developer options → Select mock location app → Melad.
 */
final class Spoofer implements Runnable {
    private static final String[] PROVIDERS = {LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, "fused"};
    private static final long PERIOD_MS = 3000;

    private final LocationManager lm;
    private final Handler handler;
    private double lat, lon;
    private boolean on;
    /** Static so the reason survives the engine stopping itself. */
    static volatile String error = "";

    Spoofer(Context c, Handler handler) {
        this.lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
        this.handler = handler;
    }

    boolean active() { return on; }

    @SuppressWarnings("deprecation")
    @android.annotation.SuppressLint("WrongConstant") // Android 10/11 API: Criteria values equal the new ones
    void start(double lat, double lon) {
        this.lat = lat;
        this.lon = lon;
        error = "";
        if (!on) {
            for (String p : PROVIDERS) {
                try {
                    try { lm.removeTestProvider(p); } catch (RuntimeException ignored) { }
                    if (Build.VERSION.SDK_INT >= 31) {
                        lm.addTestProvider(p, new ProviderProperties.Builder()
                                .setHasAltitudeSupport(true).setHasSpeedSupport(true).setHasBearingSupport(true)
                                .setAccuracy(ProviderProperties.ACCURACY_FINE)
                                .setPowerUsage(ProviderProperties.POWER_USAGE_LOW).build());
                    } else {
                        lm.addTestProvider(p, false, false, false, false, true, true, true,
                                android.location.Criteria.POWER_LOW, android.location.Criteria.ACCURACY_FINE);
                    }
                    lm.setTestProviderEnabled(p, true);
                } catch (SecurityException e) {
                    error = "Pick Melad in Developer options → Select mock location app";
                    return;
                } catch (RuntimeException e) {
                    // "fused" is not a test provider on every Android version; others are enough
                }
            }
            on = true;
        }
        handler.removeCallbacks(this);
        handler.post(this);
    }

    void stop() {
        handler.removeCallbacks(this);
        if (!on) return;
        on = false;
        for (String p : PROVIDERS) {
            try { lm.removeTestProvider(p); } catch (RuntimeException ignored) { }
        }
    }

    @Override public void run() {
        if (!on) return;
        for (String p : PROVIDERS) {
            Location l = new Location(p);
            // sub-metre wobble: a perfectly frozen fix is itself a "this is fake" signal
            l.setLatitude(lat + (Math.random() - 0.5) * 0.000008);
            l.setLongitude(lon + (Math.random() - 0.5) * 0.000008);
            l.setAltitude(30);
            l.setAccuracy(4f + (float) Math.random() * 3f);
            l.setSpeed(0f);
            l.setBearing(0f);
            l.setTime(System.currentTimeMillis());
            l.setElapsedRealtimeNanos(SystemClock.elapsedRealtimeNanos());
            try {
                lm.setTestProviderLocation(p, l);
            } catch (SecurityException e) {
                error = "Pick Melad in Developer options → Select mock location app";
                stop();
                return;
            } catch (RuntimeException ignored) {
            }
        }
        handler.postDelayed(this, PERIOD_MS);
    }
}
