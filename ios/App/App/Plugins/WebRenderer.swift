import Foundation
import Capacitor
import WebKit

/**
 * Native iOS plugin: načte stránku v WKWebView, počká na dokončení vykreslení JavaScriptem
 * a vrátí finální HTML (document.documentElement.outerHTML).
 *
 * Používá se pro weby, jejichž obsah (seznam kapitol nebo samotná kapitola) je generován
 * JavaScriptem až po načtení. Obecné HTML weby se stahují přes @capacitor-community/http,
 * tento plugin je jen záložní možnost.
 *
 * Registrace probíhá automaticky prostřednictvím objc_getClassList v CapacitorBridge
 * (třída konformuje s protokolem CAPBridgedPlugin).
 */
@objc(WebRenderer)
public class WebRenderer: CAPPlugin, CAPBridgedPlugin {

    private var pendingCall: CAPPluginCall?
    private var renderWebView: WKWebView?

    public static func pluginId() -> String { "WebRenderer" }
    public static func jsName() -> String { "WebRenderer" }

    public static func pluginMethods() -> [CAPPluginMethod] {
        return [CAPPluginMethod(name: "render", returnType: CAPPluginReturnPromise)]
    }

    public static func getMethod(_ methodName: String) -> CAPPluginMethod? {
        return pluginMethods().first { $0.name == methodName }
    }

    @objc public func render(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), !urlString.isEmpty else {
            call.reject("URL is required")
            return
        }
        guard let url = URL(string: urlString) else {
            call.reject("Invalid URL")
            return
        }

        pendingCall = call

        let webView = WKWebView()
        webView.navigationDelegate = self
        self.renderWebView = webView

        var request = URLRequest(url: url, cachePolicy: .returnToNetworkElseCache, timeoutInterval: 30)
        request.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", forHTTPHeaderField: "User-Agent")
        webView.load(request)

        // Timeout po 30 sekundách
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self = self, let call = self.pendingCall else { return }
            self.pendingCall = nil
            self.renderWebView = nil
            call.reject("Rendering timeout")
        }
    }

    private func finish(with html: String?, error: Error?) {
        guard let call = pendingCall else { return }
        pendingCall = nil
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
        webView.evaluateJavaScript("document.documentElement.outerHTML") { result, error in
            if let html = result as? String {
                self.finish(with: html, error: nil)
            } else {
                self.finish(with: nil, error: error ?? NSError(domain: "WebRenderer", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to evaluate HTML"]))
            }
        }
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.finish(with: nil, error: error)
    }
}
