import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class ScopedFS {
  private allowedDirs: string[];
  private baseDir: string;

  constructor(allowedDirs?: string[], baseDir?: string) {
    this.baseDir = path.resolve(baseDir || process.cwd());
    const defaultDirs = [this.baseDir, '/tmp', os.tmpdir()];
    const dirs = allowedDirs ?? defaultDirs;
    this.allowedDirs = [...new Set(dirs.map((d) => path.resolve(d)))];
  }

  private isPathAllowed(resolved: string): boolean {
    return this.allowedDirs.some((dir) => resolved === dir || resolved.startsWith(dir + path.sep));
  }

  private resolvePath(filePath: string): string {
    const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(this.baseDir, filePath);
    if (!this.isPathAllowed(resolved)) {
      const error = new Error(`EPERM: operation not permitted, access outside allowed directories: ${filePath}`) as NodeJS.ErrnoException;
      error.code = 'EPERM';
      error.errno = -1;
      error.syscall = 'access';
      error.path = filePath;
      throw error;
    }
    return resolved;
  }

  readFileSync = (filePath: fs.PathOrFileDescriptor, options?: any): any => {
    return fs.readFileSync(this.resolvePath(filePath.toString()), options);
  };
  writeFileSync = (filePath: fs.PathOrFileDescriptor, data: any, options?: any): void => {
    fs.writeFileSync(this.resolvePath(filePath.toString()), data, options);
  };
  appendFileSync = (filePath: fs.PathOrFileDescriptor, data: any, options?: any): void => {
    fs.appendFileSync(this.resolvePath(filePath.toString()), data, options);
  };
  readdirSync = (dirPath: fs.PathLike, options?: any): any => {
    return fs.readdirSync(this.resolvePath(dirPath.toString()), options);
  };
  mkdirSync = (dirPath: fs.PathLike, options?: any): any => {
    return fs.mkdirSync(this.resolvePath(dirPath.toString()), options);
  };
  rmdirSync = (dirPath: fs.PathLike, options?: any): void => {
    fs.rmdirSync(this.resolvePath(dirPath.toString()), options);
  };
  unlinkSync = (filePath: fs.PathLike): void => {
    fs.unlinkSync(this.resolvePath(filePath.toString()));
  };
  statSync = (filePath: fs.PathLike, options?: any): any => {
    return fs.statSync(this.resolvePath(filePath.toString()), options);
  };
  lstatSync = (filePath: fs.PathLike, options?: any): any => {
    return fs.lstatSync(this.resolvePath(filePath.toString()), options);
  };
  existsSync = (filePath: fs.PathLike): boolean => {
    try { return fs.existsSync(this.resolvePath(filePath.toString())); } catch { return false; }
  };
  accessSync = (filePath: fs.PathLike, mode?: number): void => {
    fs.accessSync(this.resolvePath(filePath.toString()), mode);
  };
  copyFileSync = (src: fs.PathLike, dest: fs.PathLike, mode?: number): void => {
    fs.copyFileSync(this.resolvePath(src.toString()), this.resolvePath(dest.toString()), mode);
  };
  renameSync = (oldPath: fs.PathLike, newPath: fs.PathLike): void => {
    fs.renameSync(this.resolvePath(oldPath.toString()), this.resolvePath(newPath.toString()));
  };
  rmSync = (filePath: fs.PathLike, options?: fs.RmOptions): void => {
    fs.rmSync(this.resolvePath(filePath.toString()), options);
  };
  realpathSync = (filePath: fs.PathLike, options?: any): any => {
    const resolved = this.resolvePath(filePath.toString());
    const real = fs.realpathSync(resolved, options);
    if (!this.isPathAllowed(real.toString())) {
      const error = new Error('EPERM: operation not permitted, realpath escapes allowed directories') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return real;
  };

  readFile = (filePath: any, ...args: any[]): void => { (fs.readFile as any)(this.resolvePath(filePath.toString()), ...args); };
  writeFile = (filePath: any, data: any, ...args: any[]): void => { (fs.writeFile as any)(this.resolvePath(filePath.toString()), data, ...args); };
  readdir = (dirPath: any, ...args: any[]): void => { (fs.readdir as any)(this.resolvePath(dirPath.toString()), ...args); };
  mkdir = (dirPath: any, ...args: any[]): void => { (fs.mkdir as any)(this.resolvePath(dirPath.toString()), ...args); };
  unlink = (filePath: any, callback: any): void => { fs.unlink(this.resolvePath(filePath.toString()), callback); };
  stat = (filePath: any, ...args: any[]): void => { (fs.stat as any)(this.resolvePath(filePath.toString()), ...args); };

  createReadStream = (filePath: fs.PathLike, options?: any): fs.ReadStream => {
    return fs.createReadStream(this.resolvePath(filePath.toString()), options);
  };
  createWriteStream = (filePath: fs.PathLike, options?: any): fs.WriteStream => {
    return fs.createWriteStream(this.resolvePath(filePath.toString()), options);
  };

  get promises() {
    const self = this;
    return {
      readFile: async (fp: fs.PathLike, opts?: any) => fs.promises.readFile(self.resolvePath(fp.toString()), opts),
      writeFile: async (fp: fs.PathLike, data: any, opts?: any) => fs.promises.writeFile(self.resolvePath(fp.toString()), data, opts),
      readdir: async (dp: fs.PathLike, opts?: any) => fs.promises.readdir(self.resolvePath(dp.toString()), opts),
      mkdir: async (dp: fs.PathLike, opts?: any) => fs.promises.mkdir(self.resolvePath(dp.toString()), opts),
      unlink: async (fp: fs.PathLike) => fs.promises.unlink(self.resolvePath(fp.toString())),
      stat: async (fp: fs.PathLike, opts?: any) => fs.promises.stat(self.resolvePath(fp.toString()), opts),
      access: async (fp: fs.PathLike, mode?: number) => fs.promises.access(self.resolvePath(fp.toString()), mode),
      copyFile: async (s: fs.PathLike, d: fs.PathLike, m?: number) => fs.promises.copyFile(self.resolvePath(s.toString()), self.resolvePath(d.toString()), m),
      rename: async (o: fs.PathLike, n: fs.PathLike) => fs.promises.rename(self.resolvePath(o.toString()), self.resolvePath(n.toString())),
      rm: async (fp: fs.PathLike, opts?: fs.RmOptions) => fs.promises.rm(self.resolvePath(fp.toString()), opts),
    };
  }

  constants = fs.constants;
}

export function createScopedFS(allowedDirs?: string[], baseDir?: string): ScopedFS {
  return new ScopedFS(allowedDirs, baseDir);
}
