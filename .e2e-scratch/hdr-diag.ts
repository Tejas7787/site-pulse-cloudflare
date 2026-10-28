import http from "node:http";

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-t": "1" });
  res.end("<html>x</html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

// Plain node:http path
await new Promise<void>((resolve) => {
  const req = http.request({ host: "127.0.0.1", port, path: "/", method: "GET" }, (res) => {
    console.log("PLAIN keys:", Object.keys(res.headers));
    console.log("PLAIN content-type:", res.headers["content-type"]);
    res.on("data", () => {});
    res.on("end", () => resolve());
  });
  req.end();
});

// Same options shape the pinned sender builds (lookup/agent:false/host header)
await new Promise<void>((resolve) => {
  const req = http.request(
    {
      host: "fixture.test",
      port,
      path: "/",
      method: "GET",
      headers: { host: `fixture.test:${port}` },
      agent: false,
      lookup: ((_h: string, _o: unknown, cb: Function) =>
        (cb as Function)(null, "127.0.0.1", 4)) as never,
    },
    (res) => {
      console.log("PINNED-SHAPE keys:", Object.keys(res.headers));
      console.log("PINNED-SHAPE content-type:", res.headers["content-type"]);
      res.on("data", () => {});
      res.on("end", () => resolve());
    },
  );
  req.on("error", (e) => console.log("PINNED-SHAPE error:", e));
  req.end();
});

server.close();
process.exit(0);
