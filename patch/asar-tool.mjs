/**
 * 极简 asar 读写工具：只用 Node 内置模块，不依赖 @electron/asar。
 *
 * asar 格式：
 *   8 字节  pickle 头（uint32 固定为 4 的倍数占位 + uint32 headerSize）
 *   实际布局：uint32 @0 = 4（pickle 长度字段的字节数）
 *             uint32 @4 = headerStringSize + 8
 *             uint32 @8 = headerStringSize
 *             uint32 @12 = header JSON 的字符串长度
 *             @16 起 header JSON，data 区从 8 + uint32@4 开始
 * 文件条目：{ offset: "字符串偏移", size, executable?, integrity? }
 *   offset 是**相对于 data 区起点**的十进制字符串。
 */
import { readFileSync, writeFileSync } from 'node:fs'

export function readAsar(path) {
  const buf = readFileSync(path)
  const pickleLen = buf.readUInt32LE(0)
  const headerSize = buf.readUInt32LE(4)
  const jsonLen = buf.readUInt32LE(12)
  const jsonStart = 16
  const header = JSON.parse(buf.subarray(jsonStart, jsonStart + jsonLen).toString('utf8'))
  const dataStart = 8 + headerSize
  return { buf, header, dataStart, pickleLen, headerSize, jsonLen }
}

export function findEntry(header, logicalPath) {
  const parts = logicalPath.split('/').filter(Boolean)
  let node = header
  for (const part of parts) {
    if (!node.files || !node.files[part]) return null
    node = node.files[part]
  }
  return node
}

export function readEntry(asar, logicalPath) {
  const entry = findEntry(asar.header, logicalPath)
  if (entry === null || entry.files) return null
  const start = asar.dataStart + Number(entry.offset)
  return asar.buf.subarray(start, start + entry.size)
}

/**
 * 用「整包重写」的方式替换一个文件的内容。
 * 不重算 integrity（Electron 默认不校验 header 里的 integrity 字段；若该校验存在会直接报错，不会静默）。
 */
export function rewriteWithFile(asar, logicalPath, newContent, outPath) {
  const entry = findEntry(asar.header, logicalPath)
  if (entry === null || entry.files) throw new Error(`not a file entry: ${logicalPath}`)

  const oldStart = Number(entry.offset)
  const oldEnd = oldStart + entry.size
  const newSize = Buffer.byteLength(newContent)

  // 数据区：把该文件之前的部分照抄，换成新内容，之后的部分照抄但偏移整体平移。
  const before = asar.buf.subarray(asar.dataStart, asar.dataStart + oldStart)
  const after = asar.buf.subarray(asar.dataStart + oldEnd)
  const delta = newSize - entry.size
  const shiftEntry = (node) => {
    if (node.files) { for (const k of Object.keys(node.files)) shiftEntry(node.files[k]); return }
    const off = Number(node.offset)
    if (off >= oldEnd) node.offset = String(off + delta)
  }
  shiftEntry(asar.header)
  entry.size = newSize

  const newData = Buffer.concat([before, Buffer.from(newContent, 'utf8'), after])
  // 必须用紧凑 JSON：asar 的 pickle 头里 @12 记的是**未补齐**的 JSON 字节长度，
  // @8 才是补齐后的长度。两者写错任何一个，Electron 读 header 就会在末尾
  // 撞上 NUL 填充而报 "Unexpected non-whitespace character after JSON"。
  const headerJson = Buffer.from(JSON.stringify(asar.header), 'utf8')

  // header 区字段布局（实测自原版 app.asar，写错任何一个 Electron 就读不进来）：
  //   @0  = 4                        pickle 长度字段本身占 4 字节
  //   @12 = jsonLen                  未补齐的 JSON 长度
  //   @8  = ceil8(jsonLen) + 4       已补齐的 header 长度
  //   @4  = @8 + 4                   之后的 header 区总长
  //   data 区起点 = 8 + @4
  // 例：jsonLen 5697805 → ceil8 5697808 → @8 5697812 → @4 5697816 → dataStart 5697824
  const padded = Math.ceil(headerJson.length / 8) * 8
  const headerJsonPadded = Buffer.concat([headerJson, Buffer.alloc(padded - headerJson.length, 0)])

  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(padded + 8, 4)
  head.writeUInt32LE(padded + 4, 8)
  head.writeUInt32LE(headerJson.length, 12)

  const out = Buffer.concat([head, headerJsonPadded, newData])
  writeFileSync(outPath, out)
  return { outBytes: out.length, delta, newSize, oldSize: entry.size === newSize ? newSize : undefined }
}

export function listFiles(header, prefix = '', out = []) {
  for (const key of Object.keys(header.files || {})) {
    const node = header.files[key]
    const p = prefix + '/' + key
    if (node.files) listFiles(node, p, out)
    else out.push(p)
  }
  return out
}
