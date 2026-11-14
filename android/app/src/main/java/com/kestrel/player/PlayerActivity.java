package com.kestrel.player;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Full-screen player. For live TV, D-pad up/down (or channel up/down) zaps through the channel list
 * it was given. Returns the last position so the app can offer "resume".
 */
@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends AppCompatActivity {
    static final String EXTRA_ITEMS = "items";
    static final String EXTRA_INDEX = "index";
    static final String EXTRA_START_MS = "startMs";
    static final String EXTRA_LIVE = "live";
    static final String EXTRA_USER_AGENT = "userAgent";
    static final String EXTRA_POSITION_MS = "positionMs";
    static final String EXTRA_DURATION_MS = "durationMs";
    static final String EXTRA_ENDED = "ended";

    private ExoPlayer player;
    private PlayerView playerView;
    private TextView banner;
    private TextView errorView;
    private JSONArray items;
    private int index;
    private boolean live;
    private boolean ended;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable hideBanner = () -> banner.setVisibility(View.GONE);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat insets = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        insets.hide(WindowInsetsCompat.Type.systemBars());
        insets.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);

        Intent in = getIntent();
        try {
            items = new JSONArray(in.getStringExtra(EXTRA_ITEMS));
        } catch (Exception e) {
            finish();
            return;
        }
        index = Math.max(0, Math.min(in.getIntExtra(EXTRA_INDEX, 0), items.length() - 1));
        live = in.getBooleanExtra(EXTRA_LIVE, false);
        String ua = in.getStringExtra(EXTRA_USER_AGENT);
        if (ua == null || ua.isEmpty()) ua = "KestrelPlayer/1.0 (Linux; Android)";

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        playerView = new PlayerView(this);
        playerView.setKeepScreenOn(true);
        playerView.setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS);
        if (live) {
            playerView.setShowFastForwardButton(false);
            playerView.setShowRewindButton(false);
        }
        root.addView(playerView, new FrameLayout.LayoutParams(-1, -1));

        banner = new TextView(this);
        banner.setTextColor(Color.WHITE);
        banner.setTextSize(22);
        banner.setPadding(40, 24, 40, 24);
        banner.setBackgroundColor(0xCC0B1220);
        FrameLayout.LayoutParams bl = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.START);
        bl.setMargins(48, 48, 48, 48);
        root.addView(banner, bl);

        errorView = new TextView(this);
        errorView.setTextColor(Color.WHITE);
        errorView.setTextSize(18);
        errorView.setGravity(Gravity.CENTER);
        errorView.setPadding(48, 32, 48, 32);
        errorView.setBackgroundColor(0xDD7F1D1D);
        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
        setContentView(root);

        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent(ua)
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(20000);
        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(this).setDataSourceFactory(http))
                .build();
        playerView.setPlayer(player);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlayerError(@NonNull PlaybackException error) {
                errorView.setText("Can't play this stream\n" + error.getErrorCodeName()
                        + "\n\nPress OK to retry" + (live && items.length() > 1 ? ", ▲▼ for another channel" : "")
                        + ", Back to close");
                errorView.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) errorView.setVisibility(View.GONE);
                if (state == Player.STATE_ENDED && !live) {
                    ended = true;
                    finishWithResult();
                }
            }
        });
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (playerView.isControllerFullyVisible()) playerView.hideController();
                else finishWithResult();
            }
        });
        load(in.getLongExtra(EXTRA_START_MS, 0));
    }

    private void load(long startMs) {
        JSONObject item = items.optJSONObject(index);
        if (item == null) return;
        String url = item.optString("url");
        MediaItem.Builder b = new MediaItem.Builder().setUri(Uri.parse(url));
        String lower = url.toLowerCase();
        if (lower.contains(".m3u8")) b.setMimeType(MimeTypes.APPLICATION_M3U8);
        else if (lower.contains(".mpd")) b.setMimeType(MimeTypes.APPLICATION_MPD);
        if (live) b.setLiveConfiguration(new MediaItem.LiveConfiguration.Builder().setTargetOffsetMs(C.TIME_UNSET).build());
        errorView.setVisibility(View.GONE);
        player.setMediaItem(b.build(), startMs > 0 ? startMs : C.TIME_UNSET);
        player.prepare();
        player.setPlayWhenReady(true);
        showBanner(item);
    }

    private void showBanner(JSONObject item) {
        String title = item.optString("title");
        String sub = item.optString("subtitle");
        String num = live && items.length() > 1 ? (index + 1) + "  " : "";
        banner.setText(num + title + (sub.isEmpty() ? "" : "\n" + sub));
        banner.setVisibility(View.VISIBLE);
        handler.removeCallbacks(hideBanner);
        handler.postDelayed(hideBanner, 4000);
    }

    private void zap(int delta) {
        if (items.length() < 2) return;
        index = (index + delta + items.length()) % items.length();
        load(0);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            int code = event.getKeyCode();
            boolean controlsShown = playerView.isControllerFullyVisible();
            if (live && (code == KeyEvent.KEYCODE_CHANNEL_UP || (!controlsShown && code == KeyEvent.KEYCODE_DPAD_UP))) {
                zap(-1);
                return true;
            }
            if (live && (code == KeyEvent.KEYCODE_CHANNEL_DOWN || (!controlsShown && code == KeyEvent.KEYCODE_DPAD_DOWN))) {
                zap(1);
                return true;
            }
            if (errorView.getVisibility() == View.VISIBLE
                    && (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER)) {
                load(live ? 0 : player.getCurrentPosition());
                return true;
            }
            if (code == KeyEvent.KEYCODE_INFO || code == KeyEvent.KEYCODE_GUIDE) {
                JSONObject item = items.optJSONObject(index);
                if (item != null) showBanner(item);
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }


    private void finishWithResult() {
        Intent data = new Intent();
        if (player != null) {
            long dur = player.getDuration();
            data.putExtra(EXTRA_POSITION_MS, ended ? 0 : Math.max(0, player.getCurrentPosition()));
            data.putExtra(EXTRA_DURATION_MS, dur == C.TIME_UNSET ? 0 : dur);
        }
        data.putExtra(EXTRA_INDEX, index);
        data.putExtra(EXTRA_ENDED, ended);
        setResult(Activity.RESULT_OK, data);
        finish();
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (player != null && !isFinishing()) player.pause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }
}
