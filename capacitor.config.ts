import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize, KeyboardStyle } from "@capacitor/keyboard";
import { Style as StatusBarStyle } from "@capacitor/status-bar";

const config: CapacitorConfig = {
  appId: "com.novelforge.app",
  appName: "NovelForge",
  webDir: "dist",
  ios: {
    scheme: "App",
    // Keep CocoaPods in sync with the committed ios/App/App.xcworkspace + Podfile.
    // (Capacitor 8 creates new projects with SPM by default, this repo uses Pods.)
    contentInset: "always",
    backgroundColor: "#0a0a0b",
    limitsNavigationsToAppBoundDomains: false,
  },
  server: {
    androidScheme: "https",
    iosScheme: "capacitor",
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: "#0a0a0b",
      androidSplashResourceName: "splash",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
    },
    StatusBar: {
      style: StatusBarStyle.Dark,
      backgroundColor: "#0a0a0b",
    },
    Keyboard: {
      resize: KeyboardResize.Ionic,
      style: KeyboardStyle.Dark,
    },
    // Native HTTP (NSURLSession) – no CORS, cookies honoured. Used by src/services/http.ts.
    CapacitorHttp: {
      enabled: true,
    },
    // Custom in-repo Swift plugin (ios/App/App/Plugins/WebRenderer.swift).
    // Its class is injected into capacitor.config.json by scripts/patch-ios-plugins.mjs.
    WebRenderer: {},
  },
};

export default config;
