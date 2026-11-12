export default {
  appId: "com.novelforge.app",
  appName: "NovelForge",
  webDir: "dist",
  server: {
    androidScheme: "https",
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
      style: "DARK",
      backgroundColor: "#0a0a0b",
    },
    Keyboard: {
      resize: "ionic",
      style: "DARK",
    },
  },
}
