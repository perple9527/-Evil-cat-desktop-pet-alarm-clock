// npm start 启动器：直接调用本项目 node_modules 里的 electron 可执行文件。
// 不依赖 node_modules/.bin 里的 shim（该目录缺失时 npm start 会报
// "electron 不是内部或外部命令"），因此更稳。
const { spawn } = require('child_process');
const path = require('path');

// require('electron') 在 Node 环境中返回 electron.exe 的完整路径
const electronPath = require('electron');
const appPath = path.join(__dirname, '..');

const child = spawn(electronPath, [appPath], {
  stdio: 'inherit', // 把应用的输出直接接到当前终端
  cwd: appPath,
});

child.on('error', (err) => {
  console.error('启动 electron 失败：', err.message);
  process.exit(1);
});

child.on('exit', (code) => process.exit(code ?? 0));
