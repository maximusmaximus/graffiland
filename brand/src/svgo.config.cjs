// Lossless-looking cleanup: keep viewBox and <title>, 3-decimal precision.
module.exports = {
  multipass: true,
  floatPrecision: 3,
  plugins: [{ name: 'preset-default', params: { overrides: { removeViewBox: false, removeTitle: false } } }],
};
