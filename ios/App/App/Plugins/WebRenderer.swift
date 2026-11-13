import Foundation
import Capacitor
import WebKit
import UIKit

/**
 * Nativní iOS plugin: načte stránku v WKWebView, počká na dokončení vykreslení JavaScriptem
 * a vrátí finální HTML (document.documentElement.outerHTML).
 *
 * BEZPEČNOST VLÁKEN (oprava pádu ve verzi 1.2.2):
 * Capacitor volá metody pluginu na FRONTĚ NA POZADÍ ("bridge"), ne na hlavním vlákně.
 * WKWebView se ale smí vytvářet a používat jen na hlavním vlákně. Starší verze vytvářela
 * WKWebView přímo v `render` (tedy na pozadí) a sdílený stav měnila ze dvou vláken zároveň.
 * Teď platí:
 *   - veškerá práce s WKWebView i se stavem pluginu běží výhradně na hlavním vlákně,
 *   - požadavky se řadí do FRONTY a zpracovávají po jednom (dřív nový požadavek zrušil
 *     ten předchozí, takže se souběžná stahování navzájem rušila),
 *   - po každém vykreslení se WKWebView zastaví a uvolní,
 *   - pád procesu s webovým obsahem (nedostatek paměti) skončí chybou, ne zaseknutím.
 *
 * Registrace: Capacitor 8 plugin auto-registruje podle `capacitor.config.json`
 * (packageClassList). Třída musí konformovat s CAPBridgedPlugin.
 */
@objc(WebRenderer)
public class WebRenderer: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "WebRenderer"
    public let jsName = "WebRenderer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "render", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelPendingRender", returnType: CAPPluginReturnPromise)
    ]

    private struct Job {
        let call: CAPPluginCall
        let url: URL
        let delayMs: Int
    }

    private static let userAgent =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
    /// Nejvíc čekajících požadavků; další se odmítnou, aby fronta nerostla bez omezení.
    private static let maxQueued = 8
    /// Největší HTML (v jednotkách UTF-16), které se ještě předá do JavaScriptu.
    private static let maxHtmlLength = 6_000_000

    // Následující stav se čte a mění POUZE na hlavním vlákně.
    private var queue: [Job] = []
    private var current: Job?
    private var renderWebView: WKWebView?
    private var timeoutWorkItem: DispatchWorkItem?
    private var generation = 0
    private var sawBrowserCheck = false

    override public func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleMemoryWarning),
            name: UIApplication.didReceiveMemoryWarningNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    /// Systém hlásí nedostatek paměti – JavaScript na to reaguje pozastavením stahování.
    @objc private func handleMemoryWarning() {
        notifyListeners("memoryWarning", data: [:])
    }

    @objc public func render(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), !urlString.isEmpty else {
            call.reject("URL is required")
            return
        }
        guard let url = URL(string: urlString), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            call.reject("Invalid URL")
            return
        }
        let delayMs = max(0, min(call.getInt("delayMs") ?? 0, 15000))

        // Tato metoda běží na frontě Capacitoru na pozadí – vše další patří na hlavní vlákno.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                call.reject("Renderer is not available")
                return
            }
            if self.queue.count >= WebRenderer.maxQueued {
                call.reject("Render queue is full")
                return
            }
            self.queue.append(Job(call: call, url: url, delayMs: delayMs))
            self.startNextIfIdle()
        }
    }

    @objc public func cancelPendingRender(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                call.resolve()
                return
            }
            let waiting = self.queue
            self.queue.removeAll()
            for job in waiting {
                job.call.reject("Render cancelled")
            }
            self.finish(html: nil, message: "Render cancelled")
            call.resolve()
        }
    }

    // MARK: - Fronta (jen hlavní vlákno)

    private func startNextIfIdle() {
        guard current == nil, !queue.isEmpty else { return }
        let job = queue.removeFirst()
        current = job
        generation += 1
        let expected = generation
        sawBrowserCheck = false

        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
        webView.navigationDelegate = self
        webView.customUserAgent = WebRenderer.userAgent
        renderWebView = webView

        let request = URLRequest(url: job.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        webView.load(request)

        let workItem = DispatchWorkItem { [weak self] in
            guard let self = self, self.generation == expected else { return }
            let message = self.sawBrowserCheck
                ? "Browser verification page did not finish (site protection)"
                : "Rendering timeout"
            self.finish(html: nil, message: message)
        }
        timeoutWorkItem = workItem
        let limit = 30.0 + Double(job.delayMs) / 1000.0
        DispatchQueue.main.asyncAfter(deadline: .now() + limit, execute: workItem)
    }

    /// Ukončí právě běžící vykreslení, uvolní WKWebView a spustí další požadavek z fronty.
    private func finish(html: String?, message: String?) {
        timeoutWorkItem?.cancel()
        timeoutWorkItem = nil
        // Skutečná adresa po přesměrováních – volající podle ní ověří, že dostal správnou stránku.
        let finalUrl = renderWebView?.url?.absoluteString ?? ""
        releaseWebView()
        guard let job = current else { return }
        current = nil
        if let html = html {
            job.call.resolve(["html": html, "url": finalUrl])
        } else {
            job.call.reject(message ?? "No HTML returned")
        }
        DispatchQueue.main.async { [weak self] in
            self?.startNextIfIdle()
        }
    }

    private func releaseWebView() {
        guard let webView = renderWebView else { return }
        renderWebView = nil
        webView.navigationDelegate = nil
        webView.stopLoading()
        webView.removeFromSuperview()
    }

    private func readDocument(_ webView: WKWebView, expected: Int) {
        guard current != nil, generation == expected, renderWebView === webView else { return }
        webView.evaluateJavaScript("document.documentElement.outerHTML") { [weak self] result, error in
            guard let self = self else { return }
            guard self.current != nil, self.generation == expected else { return }
            guard let html = result as? String else {
                self.finish(html: nil, message: error?.localizedDescription ?? "Failed to evaluate HTML")
                return
            }
            // Automatické ověření prohlížeče (bez zásahu uživatele) stránku samo přesměruje –
            // počkáme na další načtení. Nic se neobchází: když ověření neskončí, vyprší limit.
            if html.utf16.count < 60000 && (html.contains("challenge-platform") || html.contains("<title>Just a moment")) {
                self.sawBrowserCheck = true
                return
            }
            if html.utf16.count > WebRenderer.maxHtmlLength {
                self.finish(html: nil, message: "Rendered page is too large")
                return
            }
            self.finish(html: html, message: nil)
        }
    }
}

extension WebRenderer: WKNavigationDelegate {
    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let job = current, renderWebView === webView else { return }
        let expected = generation
        if job.delayMs > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(job.delayMs)) { [weak self, weak webView] in
                guard let self = self, let webView = webView else { return }
                self.readDocument(webView, expected: expected)
            }
        } else {
            readDocument(webView, expected: expected)
        }
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard renderWebView === webView else { return }
        finish(html: nil, message: error.localizedDescription)
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard renderWebView === webView else { return }
        finish(html: nil, message: error.localizedDescription)
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard renderWebView === webView else { return }
        finish(html: nil, message: "Web content process terminated (possibly out of memory)")
    }
}
