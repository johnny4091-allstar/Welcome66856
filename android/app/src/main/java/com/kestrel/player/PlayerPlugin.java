package com.kestrel.player;

import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;

/** Opens the native full-screen player (Media3/ExoPlayer) and reports where playback stopped. */
@CapacitorPlugin(name = "NativePlayer")
public class PlayerPlugin extends Plugin {

    @PluginMethod
    public void play(PluginCall call) {
        JSArray items = call.getArray("items");
        if (items == null || items.length() == 0) {
            call.reject("No items to play");
            return;
        }
        Intent intent = new Intent(getContext(), PlayerActivity.class);
        intent.putExtra(PlayerActivity.EXTRA_ITEMS, items.toString());
        intent.putExtra(PlayerActivity.EXTRA_INDEX, call.getInt("index", 0));
        intent.putExtra(PlayerActivity.EXTRA_START_MS, (long) (call.getDouble("startPosition", 0.0) * 1000));
        intent.putExtra(PlayerActivity.EXTRA_LIVE, call.getBoolean("live", false));
        intent.putExtra(PlayerActivity.EXTRA_USER_AGENT, call.getString("userAgent", ""));
        startActivityForResult(call, intent, "onPlayerClosed");
    }

    @ActivityCallback
    private void onPlayerClosed(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject ret = new JSObject();
        Intent data = result.getData();
        if (data != null) {
            ret.put("position", data.getLongExtra(PlayerActivity.EXTRA_POSITION_MS, 0) / 1000.0);
            ret.put("duration", data.getLongExtra(PlayerActivity.EXTRA_DURATION_MS, 0) / 1000.0);
            ret.put("index", data.getIntExtra(PlayerActivity.EXTRA_INDEX, 0));
            ret.put("ended", data.getBooleanExtra(PlayerActivity.EXTRA_ENDED, false));
        }
        ret.put("ok", result.getResultCode() == Activity.RESULT_OK);
        call.resolve(ret);
    }
}
