import Foundation
import Capacitor
import WebKit

/**
 * Nativní iOS plugin: načte stránku v WKWebView, počká na dokončení vykreslení JavaScriptem
 * a vrátí finální HTML (document.documentElement.outerHTML).
 *
 * Používá se pro weby, jejichž obsah (seznam kapitol nebo samotná kapitola) je generován
 * JavaScriptem až po načtení. Obecné HTML weby se stahují přes CapacitorHttp (součást
 * @capacitor/core), tento plugin je jen záložní možnost pro JS-renderované stránky.
 *
 * Registrace: Capacitor 8 plugin auto-registruje podle `capacitor.config.json`
 * (packageClassList). Třída musí konformovat s CAPBridgedPlugin – v Capacitoru 7+
 * jsou `identifier`, `jsName` a `pluginMethods` instanční vlastnosti, nikoli statické metody.
 */
@objc(WebRenderer)
public class WebRenderer: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "WebRenderer"
    public let jsName = "WebRenderer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "render", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?
    private var renderWebView: WKWebView?
    private var timeoutWorkItem: DispatchWorkItem?
    /// Prodleva po načtení stránky, než se přečte DOM (obsah dotahovaný skriptem).
    private var settleDelayMs: Int = 0
    /// Stránka naposledy ukázala automatické ověření prohlížeče (čeká se na její přesměrování).
    private var sawBrowserCheck = false

    @objc public func render(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), !urlString.isEmpty else {
            call.reject("URL is required")
            return
        }
        guard let url = URL(string: urlString) else {
            call.reject("Invalid URL")
            return
        }
        // Only one render at a time – cancel any previous pending call.
        cancelPending(with: "Render cancelled: a new render request started")

        pendingCall = call
        settleDelayMs = max(0, min(call.getInt("delayMs") ?? 0, 15000))
        sawBrowserCheck = false

        let webView = WKWebView(frame: .zero)
        webView.navigationDelegate = self
        self.renderWebView = webView

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.setValue(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
            forHTTPHeaderField: "User-Agent"
        )
        webView.load(request)

        // Timeout after 30 seconds.
        let workItem = DispatchWorkItem { [weak self] in
            let message = (self?.sawBrowserCheck ?? false)
                ? "Browser verification page did not finish (site protection)"
                : "Rendering timeout"
            self?.finish(with: nil, error: NSError(
                domain: "WebRenderer",
                code: -2,
                userInfo: [NSLocalizedDescriptionKey: message]
            ))
        }
        timeoutWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: workItem)
    }

    @objc public func cancelPendingRender(_ call: CAPPluginCall) {
        cancelPending(with: "Render cancelled")
        call.resolve()
    }

    private func cancelPending(with message: String) {
        timeoutWorkItem?.cancel()
        timeoutWorkItem = nil
        guard let call = pendingCall else {
            renderWebView = nil
            return
        }
        pendingCall = nil
        renderWebView?.stopLoading()
        renderWebView?.navigationDelegate = nil
        renderWebView = nil
        call.reject(message)
    }

    private func finish(with html: String?, error: Error?) {
        timeoutWorkItem?.cancel()
        timeoutWorkItem = nil
        guard let call = pendingCall else { return }
        pendingCall = nil
        renderWebView?.navigationDelegate = nil
        renderWebView = nil
        if let error = error {
            call.reject(error.localizedDescription)
        } else if let html = html {
            call.resolve(["html": html])
        } else {
            call.reject("No HTML returned")
        }
    }
}

extension WebRenderer: WKNavigationDelegate {
    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard pendingCall != nil else { return }
        let delay = settleDelayMs
        if delay > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(delay)) { [weak self, weak webView] in
                guard let self = self, let webView = webView, self.renderWebView === webView else { return }
                self.readDocument(webView)
            }
        } else {
            readDocument(webView)
        }
    }

    private func readDocument(_ webView: WKWebView) {
        guard pendingCall != nil else { return }
        webView.evaluateJavaScript("document.documentElement.outerHTML") { [weak self] result, error in
            guard let self = self else { return }
            if let html = result as? String {
                // Automatické ověření prohlížeče (bez zásahu uživatele) stránku samo
                // přesměruje – počkáme na další načtení. Nic se neobchází: když ověření
                // neskončí, vyprší časový limit a volající dostane chybu.
                if html.count < 60000 && (html.contains("challenge-platform") || html.contains("<title>Just a moment")) {
                    self.sawBrowserCheck = true
                    return
                }
                self.finish(with: html, error: nil)
            } else {
                self.finish(with: nil, error: error ?? NSError(
                    domain: "WebRenderer",
                    code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Failed to evaluate HTML"]
                ))
            }
        }
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(with: nil, error: error)
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(with: nil, error: error)
    }
}
