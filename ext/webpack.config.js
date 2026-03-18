const path = require("path");
const CopyWebpackPlugin = require("copy-webpack-plugin");

module.exports = {
  mode: "development",
  devtool: "source-map",

  entry: {
    contentScript: "./src/content_script.js",
    contentScriptMain: "./src/content_script_main.js",
    backgroundScript: "./src/background_script.js",
    offscreen: "./src/offscreen.js",
    panel: "./src/panel.js",
    panelApp: "./src/panel-app.js",
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: path.resolve(__dirname, "src/panel.html") },
        { from: path.resolve(__dirname, "src/main.html") },
        { from: path.resolve(__dirname, "src/offscreen.html") },
        {
          from: "*.png",
          to: "icons/[name][ext]",
          context: path.resolve(__dirname, "src/icons"),
        },
      ],
    }),
  ],
  output: {
    filename: "[name].js",
    path: path.resolve(__dirname, "build"),
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
        },
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
};
