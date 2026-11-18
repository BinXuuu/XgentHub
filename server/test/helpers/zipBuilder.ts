import zlib from "node:zlib";

// 测试用的最小 zip 打包：可以造出正常包，也能造出带 ..、符号链接、假大小之类的坏包。

export interface ZipFileSpec {
  name: string;
  data?: string | Buffer;
  /** 0 = 不压缩，8 = deflate（默认）。 */
  method?: 0 | 8;
  /** 标成 Unix 符号链接。 */
  symlink?: boolean;
  /** 在目录里谎报解压后的大小。 */
  fakeSize?: number;
  encrypted?: boolean;
}

export function buildZip(files: ZipFileSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? "", "utf8");
    const method = file.name.endsWith("/") ? 0 : file.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data) >>> 0;
    const size = file.fakeSize ?? data.length;
    const flags = 0x800 | (file.encrypted ? 1 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = file.symlink ? 0o120777 : file.name.endsWith("/") ? 0o040755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}
