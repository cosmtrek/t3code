import Constants from "expo-constants";

// Set by app.config.ts from the variant or the fork's T3CODE_APP_ICON.
const appIcon = Constants.expoConfig?.extra?.appIcon;

export const T3_CODE_BRAND_MARK_SOURCE =
  appIcon === "development"
    ? require("../../../../assets/dev/blueprint-ios-1024.png")
    : appIcon === "nightly"
      ? require("../../../../assets/nightly/nightly-ios-1024.png")
      : require("../../../../assets/prod/black-ios-1024.png");
