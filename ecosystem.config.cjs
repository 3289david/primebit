module.exports = {
  apps: [
    {
      name: 'primebit',
      script: 'src/index.js',
      interpreter: 'node',
      interpreter_args: '--env-file-if-exists=.env',
      cwd: __dirname,
    },
  ],
};
