/* 远程数据源。
   - 留空：只用包内快照（离线）
   - 填 GitHub Pages 地址：启动时优先拉远程，失败自动回落包内快照
   构建 APK 时 build.sh 会自动改写这个文件。 */
window.REMOTE_BASE = "";
