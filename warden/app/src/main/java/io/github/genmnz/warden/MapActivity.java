package io.github.genmnz.warden;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.Bundle;
import android.util.LruCache;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Map picker: drag to move, pinch or double-tap to zoom, the cross in the
 * middle is the spot. OpenStreetMap tiles are fetched only while this screen
 * is open and cached on the phone, so revisiting an area needs no network.
 */
public final class MapActivity extends Activity {
    static final String EXTRA_LAT = "lat", EXTRA_LON = "lon";

    private TileMap map;
    private TextView coords;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        double lat = getIntent().getDoubleExtra(EXTRA_LAT, 48.8584);
        double lon = getIntent().getDoubleExtra(EXTRA_LON, 2.2945);
        boolean fresh = lat == 0 && lon == 0;
        map = new TileMap(this, fresh ? 30 : lat, fresh ? 0 : lon, fresh ? 2 : 15);

        coords = new TextView(this);
        coords.setBackgroundColor(0xCC000000);
        coords.setTextColor(Color.WHITE);
        coords.setPadding(24, 12, 24, 12);
        map.onMove = this::showCoords;

        Button use = new Button(this);
        use.setText("Use this spot");
        use.setOnClickListener(v -> {
            setResult(RESULT_OK, new Intent().putExtra(EXTRA_LAT, map.lat()).putExtra(EXTRA_LON, map.lon()));
            finish();
        });
        Button plus = new Button(this), minus = new Button(this);
        plus.setText("+");
        minus.setText("−");
        plus.setOnClickListener(v -> map.zoomBy(1));
        minus.setOnClickListener(v -> map.zoomBy(-1));

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER);
        bar.addView(minus);
        bar.addView(use);
        bar.addView(plus);

        TextView credit = new TextView(this);
        credit.setText("© OpenStreetMap contributors");
        credit.setTextSize(10);
        credit.setTextColor(0xFF333333);
        credit.setBackgroundColor(0xAAFFFFFF);
        credit.setPadding(8, 2, 8, 2);

        FrameLayout root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        root.addView(map);
        root.addView(coords, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));
        root.addView(bar, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        FrameLayout.LayoutParams cp = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.END);
        cp.bottomMargin = 160;
        root.addView(credit, cp);
        setContentView(root);
        showCoords();
    }

    private void showCoords() {
        coords.setText(String.format(Locale.ROOT, "%.6f, %.6f   zoom %d", map.lat(), map.lon(), map.zoom));
    }

    @Override protected void onDestroy() {
        map.pool.shutdownNow();
        super.onDestroy();
    }

    /** Minimal slippy map in one View: Web Mercator maths, memory + disk tile cache. */
    @android.annotation.SuppressLint({"ViewConstructor", "ClickableViewAccessibility"})
    static final class TileMap extends View {
        private static final int TILE = 256;
        final ExecutorService pool = Executors.newFixedThreadPool(2);
        private final LruCache<String, Bitmap> mem = new LruCache<>(80);
        private final Set<String> loading = new HashSet<>();
        private final File dir;
        private final Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG), cross = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final android.graphics.RectF dst = new android.graphics.RectF();
        private final float density;
        private final ScaleGestureDetector scaler;
        private final GestureDetector gestures;
        /** centre in world pixels at the current zoom */
        private double cx, cy;
        int zoom;
        private float pinch = 1f;
        Runnable onMove;

        TileMap(Context c, double lat, double lon, int zoom) {
            super(c);
            dir = new File(c.getCacheDir(), "tiles");
            density = c.getResources().getDisplayMetrics().density;
            this.zoom = zoom;
            cx = lonToX(lon);
            cy = latToY(lat);
            cross.setColor(0xFFE53935);
            cross.setStrokeWidth(3 * density);
            setBackgroundColor(0xFFE0E0E0);
            scaler = new ScaleGestureDetector(c, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
                @Override public boolean onScale(ScaleGestureDetector d) {
                    pinch *= d.getScaleFactor();
                    if (pinch > 1.6f) { zoomBy(1); pinch = 1f; }
                    else if (pinch < 0.6f) { zoomBy(-1); pinch = 1f; }
                    return true;
                }
            });
            gestures = new GestureDetector(c, new GestureDetector.SimpleOnGestureListener() {
                @Override public boolean onScroll(MotionEvent a, MotionEvent b, float dx, float dy) {
                    double ts = TILE * density;
                    cx += dx / ts * TILE;
                    cy += dy / ts * TILE;
                    clamp();
                    moved();
                    return true;
                }

                @Override public boolean onDoubleTap(MotionEvent e) { zoomBy(1); return true; }
            });
        }

        private double world() { return TILE * (double) (1 << zoom); }

        private double lonToX(double lon) { return (lon + 180) / 360 * world(); }

        private double latToY(double lat) {
            double r = Math.toRadians(Math.max(-85, Math.min(85, lat)));
            return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * world();
        }

        double lon() { return cx / world() * 360 - 180; }

        double lat() { return Math.toDegrees(Math.atan(Math.sinh(Math.PI * (1 - 2 * cy / world())))); }

        void zoomBy(int d) {
            int z = Math.max(1, Math.min(19, zoom + d));
            if (z == zoom) return;
            double f = Math.pow(2, z - zoom);
            cx *= f;
            cy *= f;
            zoom = z;
            moved();
        }

        private void clamp() {
            double w = world();
            cx = ((cx % w) + w) % w;
            cy = Math.max(0, Math.min(w, cy));
        }

        private void moved() {
            invalidate();
            if (onMove != null) onMove.run();
        }

        @Override public boolean onTouchEvent(MotionEvent e) {
            scaler.onTouchEvent(e);
            if (!scaler.isInProgress()) gestures.onTouchEvent(e);
            return true;
        }

        @Override protected void onDraw(Canvas c) {
            float ts = TILE * density;
            int w = getWidth(), h = getHeight(), n = 1 << zoom;
            // world pixel (cx, cy) sits at the view centre
            double left = cx - w / 2.0 / density, top = cy - h / 2.0 / density;
            int tx0 = (int) Math.floor(left / TILE), ty0 = (int) Math.floor(top / TILE);
            int tx1 = (int) Math.floor((left + w / density) / TILE), ty1 = (int) Math.floor((top + h / density) / TILE);
            for (int ty = Math.max(0, ty0); ty <= Math.min(n - 1, ty1); ty++) {
                for (int tx = tx0; tx <= tx1; tx++) {
                    int wx = ((tx % n) + n) % n;
                    Bitmap bmp = tile(zoom, wx, ty);
                    if (bmp == null) continue;
                    float x = (float) ((tx * TILE - left) * density), y = (float) ((ty * TILE - top) * density);
                    dst.set(x, y, x + ts, y + ts);
                    c.drawBitmap(bmp, null, dst, paint);
                }
            }
            float mx = w / 2f, my = h / 2f, r = 14 * density;
            c.drawLine(mx - r, my, mx + r, my, cross);
            c.drawLine(mx, my - r, mx, my + r, cross);
        }

        private Bitmap tile(int z, int x, int y) {
            final String key = z + "/" + x + "/" + y;
            Bitmap b = mem.get(key);
            if (b != null) return b;
            synchronized (loading) {
                if (!loading.add(key)) return null;
            }
            pool.execute(() -> {
                Bitmap got = fetch(key);
                synchronized (loading) { loading.remove(key); }
                if (got != null) {
                    mem.put(key, got);
                    postInvalidate();
                }
            });
            return null;
        }

        private Bitmap fetch(String key) {
            File f = new File(dir, key + ".png");
            if (f.exists()) {
                Bitmap b = BitmapFactory.decodeFile(f.getPath());
                if (b != null) return b;
            }
            HttpURLConnection con = null;
            try {
                con = (HttpURLConnection) new URL("https://tile.openstreetmap.org/" + key + ".png").openConnection();
                con.setRequestProperty("User-Agent", "Melad-privacy-app/2.0 (personal use)");
                con.setConnectTimeout(8000);
                con.setReadTimeout(8000);
                if (con.getResponseCode() != 200) return null;
                f.getParentFile().mkdirs();
                File tmp = new File(f.getPath() + ".tmp");
                try (InputStream in = con.getInputStream(); FileOutputStream out = new FileOutputStream(tmp)) {
                    byte[] buf = new byte[8192];
                    for (int r; (r = in.read(buf)) > 0; ) out.write(buf, 0, r);
                }
                tmp.renameTo(f);
                return BitmapFactory.decodeFile(f.getPath());
            } catch (Exception e) {
                return null;
            } finally {
                if (con != null) con.disconnect();
            }
        }
    }
}
