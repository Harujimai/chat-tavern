package com.chattavern.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends Activity {

    private static final String TAG = "ChatTavern";
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/index.html";
    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_AUDIO_PERMISSION = 1002;

    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingAudioRequest;
    private boolean darkTheme = false;
    /** 角色预设 / 参数面板脚本。 */
    private String presetJs;
    /** 酒馆角色卡 PNG 解析上游库。 */
    private String cardLibJs;
    /** 边栏滑动手势脚本。 */
    private String gestureJs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        // 必须在创建 WebView 之前关闭调试开关，否则 Chromium 已经把 devtools 套接字打开了
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(false);
        }

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(Color.parseColor("#ffffff"));
        // 关掉 Android 的边缘辉光/拉伸效果，滚动更像浏览器而不是原生列表
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(webView);
        setContentView(root);

        configureWebView();

        if (savedInstanceState == null) {
            webView.loadUrl(START_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
        applySystemBars(false);
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setGeolocationEnabled(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 滚动时预栅格化离屏内容，长会话列表滑起来更顺（API 23+）。
        s.setOffscreenPreRaster(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        CookieManager.getInstance().setAcceptCookie(true);

        webView.addJavascriptInterface(new NativeBridge(), "DSHNative");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return assetLoader.shouldInterceptRequest(Uri.parse(url));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost())) {
                    return false;
                }
                openExternally(uri);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                view.evaluateJavascript(THEME_HOOK_JS, null);
                view.evaluateJavascript(DOWNLOAD_NAME_HOOK_JS, null);
                String lib = loadCardLibJs();
                if (lib != null) {
                    view.evaluateJavascript(lib, v -> Log.d(TAG, "cardlib injected: " + v));
                }
                String preset = loadPresetJs();
                if (preset != null) {
                    view.evaluateJavascript(preset, v -> Log.d(TAG, "preset injected: " + v));
                }
                String gesture = loadGestureJs();
                if (gesture != null) {
                    view.evaluateJavascript(gesture, v -> Log.d(TAG, "gesture injected: " + v));
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                try {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    }
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    Log.e(TAG, "file chooser failed", e);
                    fileCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> handlePermissionRequest(request));
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, "console: " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (url != null && url.startsWith("blob:")) {
                saveBlobUrl(url, contentDisposition, mimetype);
            } else if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                openExternally(Uri.parse(url));
            }
        });
    }

    private void handlePermissionRequest(PermissionRequest request) {
        boolean wantsAudio = false;
        for (String res : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) {
                wantsAudio = true;
            }
        }
        if (wantsAudio) {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(request.getResources());
            } else {
                pendingAudioRequest = request;
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO_PERMISSION);
            }
            return;
        }
        request.deny();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_AUDIO_PERMISSION && pendingAudioRequest != null) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted) {
                pendingAudioRequest.grant(pendingAudioRequest.getResources());
            } else {
                pendingAudioRequest.deny();
                toast("麦克风权限被拒绝，语音输入不可用");
            }
            pendingAudioRequest = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (fileCallback != null) {
                Uri[] result = null;
                if (resultCode == Activity.RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        result = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            result[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        result = new Uri[]{data.getData()};
                    }
                }
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** 浏览器里 <a download="x.zip" href="blob:..."> 的点按：WebView 拿不到内容，改走 fetch + base64。 */
    private void saveBlobUrl(String blobUrl, String contentDisposition, String mimetype) {
        String fallback = parseFileName(contentDisposition);
        if (fallback == null || fallback.isEmpty()) {
            fallback = "download-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date())
                    + guessExt(mimetype);
        }
        // anchor 的 download 属性不会传到 DownloadListener，只能从页面里抢（见 DOWNLOAD_NAME_HOOK_JS）
        String js = "(function(){var u=" + jsStr(blobUrl) + ",fb=" + jsStr(fallback) + ",m="
                + jsStr(mimetype == null ? "" : mimetype) + ";"
                + "var n=(window.__dshDownloadName||'').replace(/[\\\\/:*?\"<>|]/g,'_');window.__dshDownloadName='';"
                + "n=n||fb;if(!m){m=/\\.zip$/i.test(n)?'application/zip':''}"
                + "fetch(u).then(function(r){return r.blob()}).then(function(b){"
                + "return new Promise(function(res,rej){var fr=new FileReader();fr.onload=function(){res(fr.result)};fr.onerror=rej;fr.readAsDataURL(b)})"
                + "}).then(function(d){window.DSHNative.saveBase64(d,n,m||'application/octet-stream')})"
                + ".catch(function(e){window.DSHNative.toast('导出失败: '+e)})})()";
        webView.evaluateJavascript(js, null);
    }

    /** 边栏跟手滑出 / 滑回。 */
    private String loadGestureJs() {
        if (gestureJs == null) gestureJs = readAsset("dsh-gesture.js");
        return gestureJs;
    }

    /** 角色预设 / 参数面板脚本。 */
    private String loadPresetJs() {
        if (presetJs == null) presetJs = readAsset("dsh-preset.js");
        return presetJs;
    }

    /** 酒馆角色卡 PNG 解析上游库。 */
    private String loadCardLibJs() {
        if (cardLibJs == null) cardLibJs = readAsset("dsh-cardlib.js");
        return cardLibJs;
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return out.toString("UTF-8");
        } catch (Exception e) {
            Log.e(TAG, "read asset failed: " + name, e);
            return null;
        }
    }

    private static String guessExt(String mimetype) {        if (mimetype == null) return "";
        if (mimetype.contains("zip")) return ".zip";
        if (mimetype.contains("json")) return ".json";
        if (mimetype.startsWith("text/")) return ".txt";
        return "";
    }

    private static String parseFileName(String contentDisposition) {
        if (contentDisposition == null) return null;
        // 支持 filename=xxx 与 RFC5987 的 filename*=UTF-8''xxx
        int idx = contentDisposition.indexOf("filename*=");
        if (idx >= 0) {
            String rest = contentDisposition.substring(idx + 10);
            int semi = rest.indexOf(';');
            if (semi >= 0) rest = rest.substring(0, semi);
            rest = rest.trim();
            int q1 = rest.indexOf("''");
            if (q1 >= 0) {
                try {
                    return Uri.decode(rest.substring(q1 + 2));
                } catch (Exception ignored) {
                    return rest.substring(q1 + 2);
                }
            }
        }
        idx = contentDisposition.indexOf("filename=");
        if (idx >= 0) {
            String rest = contentDisposition.substring(idx + 9).trim();
            int semi = rest.indexOf(';');
            if (semi >= 0) rest = rest.substring(0, semi);
            rest = rest.trim();
            if (rest.startsWith("\"") && rest.endsWith("\"") && rest.length() > 1) {
                rest = rest.substring(1, rest.length() - 1);
            }
            return rest;
        }
        return null;
    }

    private static String jsStr(String s) {
        if (s == null) return "''";
        StringBuilder sb = new StringBuilder("'");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '\'': sb.append("\\'"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                default: sb.append(c);
            }
        }
        return sb.append("'").toString();
    }

    private void openExternally(Uri uri) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            toast("无法打开链接");
        }
    }

    private void toast(final String msg) {
        runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
    }

    private void applySystemBars(boolean dark) {
        darkTheme = dark;
        Window w = getWindow();
        int bg = Color.parseColor(dark ? "#151517" : "#ffffff");
        w.setStatusBarColor(bg);
        w.setNavigationBarColor(bg);
        View decor = w.getDecorView();
        int flags = decor.getSystemUiVisibility();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (dark) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            } else {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (dark) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            } else {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
        }
        decor.setSystemUiVisibility(flags);
        webView.setBackgroundColor(bg);
    }

    /**
     * 返回键：先让页面自己收层。站内无路由，所以顺序是「关一层 → 再关一层 → 才退出」。
     * 连续 4 次都关不掉就强制退出，避免把用户困死。
     */
    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        if (webView.canGoBack()) {
            overlayBackStreak = 0;
            webView.goBack();
            return;
        }
        webView.evaluateJavascript(OVERLAY_CHECK_JS, value -> {
            if (!"true".equals(value)) {
                overlayBackStreak = 0;
                finish();
                return;
            }
            overlayBackStreak++;
            if (overlayBackStreak >= 4) {
                overlayBackStreak = 0;
                finish();
                return;
            }
            webView.evaluateJavascript(CLICK_MASK_JS, null);
            webView.postDelayed(() -> {
                if (webView == null) return;
                webView.evaluateJavascript(OVERLAY_CHECK_JS, again -> {
                    if ("true".equals(again)) webView.evaluateJavascript(ESCAPE_JS, null);
                });
            }, 350);
        });
    }

    private int overlayBackStreak = 0;

    /** 页面里是否有可见的弹层/抽屉/遮罩（用类名前缀判定，比 z-index 靠谱）。 */
    private static final String OVERLAY_CHECK_JS =
            "(function(){try{"
                    + "function vis(e){var s=getComputedStyle(e),r=e.getBoundingClientRect();"
                    + "return s.display!=='none'&&s.visibility!=='hidden'&&parseFloat(s.opacity)>0.01&&r.width>40&&r.height>40}"
                    + "var l=document.querySelectorAll('[class*=\"overlay-\"],[class*=\"dshs-overlay\"],[class*=\"drawer-\"],[class*=\"Mask\"]');"
                    + "for(var i=0;i<l.length;i++){if(vis(l[i]))return true}"
                    + "if(document.querySelector('dialog[open]'))return true;"
                    + "return false}catch(x){return false}})()";

    /**
     * 点最上层遮罩。注意别点面板本体：settings 面板那层 z=1000 的 div 本身就是 scrim，
     * 但 drawer 的遮罩是独立的 drawerMask（z=799），点它才会收起侧栏。
     */
    private static final String CLICK_MASK_JS =
            "(function(){try{"
                    + "if(document.querySelector('.dshs-overlay')&&window.__dshStudioClose){window.__dshStudioClose();return 'studio'}"
                    + "var sel='[class*=\"mask\"],[class*=\"Mask\"],[class*=\"overlay\"],[class*=\"backdrop\"],[class*=\"scrim\"]';"
                    + "var l=[].slice.call(document.querySelectorAll(sel)).filter(function(e){var s=getComputedStyle(e);"
                    + "return s.display!=='none'&&s.visibility!=='hidden'&&e.getBoundingClientRect().width>0});"
                    + "l.sort(function(a,b){return (parseInt(getComputedStyle(b).zIndex,10)||0)-(parseInt(getComputedStyle(a).zIndex,10)||0)});"
                    + "if(!l.length)return 'none';"
                    + "var t=l[0],r=t.getBoundingClientRect(),x=r.left+Math.min(20,r.width/2),y=r.top+r.height/2;"
                    + "['mousedown','mouseup','click'].forEach(function(k){"
                    + "t.dispatchEvent(new MouseEvent(k,{bubbles:true,cancelable:true,view:window,clientX:x,clientY:y}))});"
                    + "return 'mask'}catch(x){return 'err'}})()";

    /** 页面只认 DOM 上的 Escape 键在关弹层（已实测可关 settings 面板）。 */
    private static final String ESCAPE_JS =
            "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true}))";

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /** 页面里的主题变化同步到状态栏/导航栏，避免深色模式下顶部一片惨白。 */
    private static final String THEME_HOOK_JS =
            "(function(){if(window.__dshThemeHooked)return;window.__dshThemeHooked=1;"
                    + "function isDark(){var b=document.body,e=document.documentElement;"
                    + "function hit(n){return !!n&&(n.classList.contains('dark')||n.hasAttribute('data-ds-dark-theme'))}"
                    + "return hit(b)||hit(e)}"
                    + "function sync(){try{window.DSHNative&&window.DSHNative.setDark(isDark())}catch(x){}}"
                    + "var opt={attributes:true,attributeFilter:['class','data-ds-dark-theme']};"
                    + "if(document.body)new MutationObserver(sync).observe(document.body,opt);"
                    + "if(document.documentElement)new MutationObserver(sync).observe(document.documentElement,opt);"
                    + "sync();setTimeout(sync,300);setTimeout(sync,1200);"
                    + "})();";

    /** 记住被点掉的 <a download="…"> 文件名，下载时由 Java 侧读取。 */
    private static final String DOWNLOAD_NAME_HOOK_JS =
            "(function(){if(window.__dshDlHooked)return;window.__dshDlHooked=1;"
                    + "document.addEventListener('click',function(e){try{var t=e.target;"
                    + "var a=t&&t.closest?t.closest('a[download]'):null;"
                    + "if(a){window.__dshDownloadName=a.getAttribute('download')||''}}catch(x){}},true);"
                    + "})();";

    public class NativeBridge {

        @JavascriptInterface
        public void setDark(final boolean dark) {
            runOnUiThread(() -> {
                if (dark != darkTheme) applySystemBars(dark);
            });
        }

        @JavascriptInterface
        public void toast(final String msg) {
            MainActivity.this.toast(msg);
        }

        /** 面板里显示版本号，免得再分不清装的是哪一版。 */
        @JavascriptInterface
        public String version() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        /** 轻触反馈：面板按钮、保存等交互用，配合 setOverScrollMode(NEVER) 让整体手感不那么「硬」。 */
        @JavascriptInterface
        public void haptic() {
            try {
                Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (v == null || !v.hasVibrator()) return;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    v.vibrate(VibrationEffect.createOneShot(12, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(12);
                }
            } catch (Exception ignored) {
            }
        }

        /** 收起输入法：页面下滑时调用，交给系统做过场动画。 */
        @JavascriptInterface
        public void hideKeyboard() {
            runOnUiThread(() -> {
                try {
                    InputMethodManager imm =
                            (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                    if (imm != null) {
                        View focus = getCurrentFocus();
                        if (focus != null) imm.hideSoftInputFromWindow(focus.getWindowToken(), 0);
                        imm.hideSoftInputFromWindow(getWindow().getDecorView().getWindowToken(), 0);
                    }
                    if (webView != null) webView.clearFocus();
                } catch (Exception ignored) {
                }
            });
        }

        /** dataUrl 形如 data:application/zip;base64,XXXX */
        @JavascriptInterface
        public void saveBase64(final String dataUrl, final String fileName, final String mime) {
            new Thread(() -> {
                try {
                    if (dataUrl == null) {
                        toast("导出内容为空");
                        return;
                    }
                    int comma = dataUrl.indexOf(',');
                    if (comma < 0) {
                        toast("导出内容格式错误");
                        return;
                    }
                    byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
                    String m = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
                    String ok = writeToDownloads(bytes, fileName, m);
                    if (ok != null) {
                        toast("已保存到 " + ok);
                    } else {
                        toast("保存失败");
                    }
                } catch (Exception e) {
                    Log.e(TAG, "saveBase64 failed", e);
                    toast("保存失败: " + e.getMessage());
                }
            }).start();
        }

        private String writeToDownloads(byte[] bytes, String fileName, String mime) throws Exception {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                values.put(MediaStore.Downloads.MIME_TYPE, mime);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                ContentResolver resolver = getContentResolver();
                Uri item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (item == null) return null;
                try (OutputStream os = resolver.openOutputStream(item)) {
                    if (os == null) return null;
                    os.write(bytes);
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(item, values, null, null);
                return "下载/" + fileName;
            } else {
                java.io.File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists() && !dir.mkdirs()) return null;
                java.io.File out = new java.io.File(dir, fileName);
                try (OutputStream os = new java.io.FileOutputStream(out)) {
                    os.write(bytes);
                }
                return out.getAbsolutePath();
            }
        }
    }
}
