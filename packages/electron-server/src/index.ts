import { utilityProcess, UtilityProcess } from "electron";
import net from "net";
import path from "path";

const DEFAULT_PORT = 3000;

export class NextServerManager {
  private child: UtilityProcess | null = null;
  private port: number = DEFAULT_PORT;
  private _ready = false;
  private readyCallbacks: Array<() => void> = [];
  private rejectCallbacks: Array<(err: Error) => void> = [];

  async start(isPackaged: boolean, resourcesPath: string): Promise<number> {
    this.port = await this.findFreePort(DEFAULT_PORT);

    if (!isPackaged) {
      // Dev mode: wacht totdat de Next.js dev server reageert op de port
      await this.waitForPort(this.port);
      this._ready = true;
      this.readyCallbacks.forEach((cb) => cb());
      this.readyCallbacks = [];
      return this.port;
    }

    const serverDir = path.join(resourcesPath, "nextjs-server");
    const serverScript = path.join(serverDir, "server.js");

    // utilityProcess.fork gebruikt Electron's ingebouwde Node.js runtime
    this.child = utilityProcess.fork(serverScript, [], {
      serviceName: "next-server",
      stdio: "pipe",
      cwd: serverDir,
      env: {
        ...process.env,
        PORT: String(this.port),
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
      },
    });

    this.child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      console.log("[next-server]", text.trim());
      if (text.includes("Ready") || text.includes("started server") || text.includes("Local:")) {
        if (!this._ready) {
          this._ready = true;
          this.readyCallbacks.forEach((cb) => cb());
          this.readyCallbacks = [];
          this.rejectCallbacks = [];
        }
      }
    });

    this.child.stderr?.on("data", (data: Buffer) => {
      console.error("[next-server stderr]", data.toString().trim());
    });

    this.child.on("exit", (code) => {
      if (!this._ready) {
        const err = new Error(`Next.js server exited early with code ${code}`);
        this.rejectCallbacks.forEach((cb) => cb(err));
        this.rejectCallbacks = [];
        this.readyCallbacks = [];
      }
    });

    await this.waitReady(30000);
    return this.port;
  }

  stop(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this._ready = false;
  }

  getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private waitReady(timeout: number): Promise<void> {
    if (this._ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Next.js server did not start within ${timeout / 1000}s`));
      }, timeout);
      this.readyCallbacks.push(() => { clearTimeout(timer); resolve(); });
      this.rejectCallbacks.push((err) => { clearTimeout(timer); reject(err); });
    });
  }

  private findFreePort(preferred: number): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(preferred, "127.0.0.1", () => {
        const addr = server.address() as net.AddressInfo;
        server.close(() => resolve(addr.port));
      });
      server.on("error", () => resolve(preferred + 1));
    });
  }

  private waitForPort(port: number, timeout = 15000): Promise<void> {
    const deadline = Date.now() + timeout;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const socket = net.createConnection({ port, host: "127.0.0.1" });
        socket.on("connect", () => { socket.destroy(); resolve(); });
        socket.on("error", () => {
          if (Date.now() > deadline) {
            reject(new Error(`Server did not respond on port ${port} within ${timeout}ms`));
          } else {
            setTimeout(attempt, 300);
          }
        });
      };
      attempt();
    });
  }
}
