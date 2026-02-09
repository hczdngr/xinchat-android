const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

const appDirectory = __dirname;
const parsedWebPort = Number(process.env.WEB_PORT);
const webPort = Number.isInteger(parsedWebPort) && parsedWebPort > 0 ? parsedWebPort : 'auto';
const webApiProxyTarget = process.env.WEB_API_PROXY_TARGET || 'http://127.0.0.1:3001';
const isWebpackServe = process.env.WEBPACK_SERVE === 'true';

const babelLoader = {
  test: /\.[jt]sx?$/,
  include: [
    path.resolve(appDirectory, 'index.web.js'),
    path.resolve(appDirectory, 'App.tsx'),
    path.resolve(appDirectory, 'src'),
    path.resolve(appDirectory, 'node_modules/react-native'),
    path.resolve(appDirectory, 'node_modules/@react-native'),
    path.resolve(appDirectory, 'node_modules/@react-navigation'),
    path.resolve(appDirectory, 'node_modules/react-native-safe-area-context'),
    path.resolve(appDirectory, 'node_modules/react-native-screens'),
    path.resolve(appDirectory, 'node_modules/react-native-gesture-handler'),
    path.resolve(appDirectory, 'node_modules/react-native-svg'),
    path.resolve(appDirectory, 'node_modules/@react-native-async-storage'),
  ],
  use: {
    loader: 'babel-loader',
    options: {
      cacheDirectory: true,
      presets: [['module:@react-native/babel-preset', { disableImportExportTransform: true }]],
      sourceType: 'unambiguous',
    },
  },
};

module.exports = {
  entry: path.resolve(appDirectory, 'index.web.js'),
  output: {
    path: path.resolve(appDirectory, 'dist'),
    filename: 'bundle.[contenthash].js',
    publicPath: '/',
    clean: true,
  },
  resolve: {
    extensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
    alias: {
      'react-native$': 'react-native-web',
    },
    fallback: {
      fs: false,
      path: false,
      os: false,
    },
  },
  module: {
    rules: [
      {
        test: /\.m?js$/,
        resolve: {
          fullySpecified: false,
        },
      },
      babelLoader,
      {
        test: /\.(gif|jpe?g|png|svg|ttf|woff2?)$/,
        type: 'asset/resource',
      },
    ],
  },
  plugins: [
    new webpack.IgnorePlugin({
      resourceRegExp: /^react-native-reanimated$/,
    }),
    new HtmlWebpackPlugin({
      template: path.resolve(appDirectory, 'public/index.html'),
    }),
    new webpack.DefinePlugin({
      __DEV__: JSON.stringify(true),
      'globalThis.__XINCHAT_API_BASE__': JSON.stringify(
        process.env.XINCHAT_API_BASE || process.env.REACT_APP_API_BASE || process.env.VITE_API_BASE || ''
      ),
      'globalThis.__XINCHAT_WS_PROXY_PATH__': JSON.stringify(isWebpackServe ? '/chat-ws' : ''),
    }),
  ],
  performance: {
    hints: false,
  },
  devServer: {
    static: {
      directory: path.resolve(appDirectory, 'public'),
    },
    historyApiFallback: true,
    port: webPort,
    hot: true,
    proxy: [
      {
        context: ['/api', '/uploads', '/resource', '/admin'],
        target: webApiProxyTarget,
        changeOrigin: true,
      },
      {
        context: ['/chat-ws'],
        target: webApiProxyTarget,
        ws: true,
        changeOrigin: true,
        pathRewrite: { '^/chat-ws': '/ws' },
      },
    ],
  },
};
