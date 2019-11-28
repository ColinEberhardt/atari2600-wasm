import resolve from "rollup-plugin-node-resolve";
import commonjs from "rollup-plugin-commonjs";

export default {
  input: "web/main.js",
  output: {
    file: "web/bundle.js",
    format: "iife",
    name: "MyModule",
    globals: {
      fs: "fs",
      crypto: "crypto",
      path: "path"
    }
  },
  plugins: [resolve(), commonjs()]
};
