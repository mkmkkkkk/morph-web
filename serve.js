const http = require("http");
const fs = require("fs");
const path = require("path");
const dist = path.join(__dirname, "dist");
const mime = {".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".png":"image/png",".svg":"image/svg+xml",".ico":"image/x-icon",".woff2":"font/woff2",".ttf":"font/ttf",".webmanifest":"application/manifest+json"};
http.createServer((req, res) => {
  let p = path.join(dist, req.url.split("?")[0]);
  const exists = fs.existsSync(p);
  if (!exists || fs.statSync(p).isDirectory()) p = path.join(dist, "index.html");
  const ext = path.extname(p);
  res.writeHead(200, {"Content-Type": mime[ext] || "application/octet-stream"});
  fs.createReadStream(p).pipe(res);
}).listen(8081, () => console.log("web:8081"));
