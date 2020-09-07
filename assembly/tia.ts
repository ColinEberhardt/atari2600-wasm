import Memory from "./memory";
import { CPU } from "./cpu";
import { cpu } from "./index";

// https://alienbill.com/2600/101/docs/stella.html
// https://github.com/munsie/dasm/blob/master/machines/atari2600/vcs.h
// https://gist.github.com/chesterbr/5864935
// https://gist.githubusercontent.com/chesterbr/5864935/raw/30a48f9e2959e0bcadaf6bffa781707fecba8b1d/hello.asm

// TODO: move this into the TIA code
const PALETTE_NTSC: Array<u32> = [
  0x000000, // 00
  0x404040, // 02
  0x6c6c6c, // 04
  0x909090, // 06
  0xb0b0b0, // 08
  0xc8c8c8, // 0A
  0xdcdcdc, // 0C
  0xf4f4f4, // 0E
  0x004444, // 10
  0x106464, // 12
  0x248484, // 14
  0x34a0a0, // 16
  0x40b8b8, // 18
  0x50d0d0, // 1A
  0x5ce8e8, // 1C
  0x68fcfc, // 1E
  0x002870, // 20
  0x144484, // 22
  0x285c98, // 24
  0x3c78ac, // 26
  0x4c8cbc, // 28
  0x5ca0cc, // 2A
  0x68b4dc, // 2C
  0x78c8ec, // 2E
  0x001884, // 30
  0x183498, // 32
  0x3050ac, // 34
  0x4868c0, // 36
  0x5c80d0, // 38
  0x7094e0, // 3A
  0x80a8ec, // 3C
  0x94bcfc, // 3E
  0x000088, // 40
  0x20209c, // 42
  0x3c3cb0, // 44
  0x5858c0, // 46
  0x7070d0, // 48
  0x8888e0, // 4A
  0xa0a0ec, // 4C
  0xb4b4fc, // 4E
  0x5c0078, // 50
  0x74208c, // 52
  0x883ca0, // 54
  0x9c58b0, // 56
  0xb070c0, // 58
  0xc084d0, // 5A
  0xd09cdc, // 5C
  0xe0b0ec, // 5E
  0x780048, // 60
  0x902060, // 62
  0xa43c78, // 64
  0xb8588c, // 66
  0xcc70a0, // 68
  0xdc84b4, // 6A
  0xec9cc4, // 6C
  0xfcb0d4, // 6E
  0x840014, // 70
  0x982030, // 72
  0xac3c4c, // 74
  0xc05868, // 76
  0xd0707c, // 78
  0xe08894, // 7A
  0xeca0a8, // 7C
  0xfcb4bc, // 7E
  0x880000, // 80
  0x9c201c, // 82
  0xb04038, // 84
  0xc05c50, // 86
  0xd07468, // 88
  0xe08c7c, // 8A
  0xeca490, // 8C
  0xfcb8a4, // 8E
  0x7c1800, // 90
  0x90381c, // 92
  0xa85438, // 94
  0xbc7050, // 96
  0xcc8868, // 98
  0xdc9c7c, // 9A
  0xecb490, // 9C
  0xfcc8a4, // 9E
  0x5c2c00, // A0
  0x784c1c, // A2
  0x906838, // A4
  0xac8450, // A6
  0xc09c68, // A8
  0xd4b47c, // AA
  0xe8cc90, // AC
  0xfce0a4, // AE
  0x2c3c00, // B0
  0x485c1c, // B2
  0x647c38, // B4
  0x809c50, // B6
  0x94b468, // B8
  0xacd07c, // BA
  0xc0e490, // BC
  0xd4fca4, // BE
  0x003c00, // C0
  0x205c20, // C2
  0x407c40, // C4
  0x5c9c5c, // C6
  0x74b474, // C8
  0x8cd08c, // CA
  0xa4e4a4, // CC
  0xb8fcb8, // CE
  0x003814, // D0
  0x1c5c34, // D2
  0x387c50, // D4
  0x50986c, // D6
  0x68b484, // D8
  0x7ccc9c, // DA
  0x90e4b4, // DC
  0xa4fcc8, // DE
  0x00302c, // E0
  0x1c504c, // E2
  0x347068, // E4
  0x4c8c84, // E6
  0x64a89c, // E8
  0x78c0b4, // EA
  0x88d4cc, // EC
  0x9cece0, // EE
  0x002844, // F0
  0x184864, // F2
  0x306884, // F4
  0x4484a0, // F6
  0x589cb8, // F8
  0x6cb4d0, // FA
  0x7ccce8, // FC
  0x8ce0fc // FE
];

enum Register {
  VSYNC,
  VBLANK,
  WSYNC,
  RSYNC,
  NUSIZ0,
  NUSIZ1,
  COLUP0,
  COLUP1,
  COLUPF,
  COLUBK,
  CTRLPF,
  REFP0,
  REFP1,
  PF0,
  PF1,
  PF2,
  RESP0,
  RESP1,
  RESM0,
  RESM1,
  RESBL,
  AUDC0,
  AUDC1,
  AUDF0,
  AUDF1,
  AUDV0,
  AUDV1,
  GRP0,
  GRP1,
  ENAM0,
  ENAM1,
  ENABL,
  HMP0,
  HMP1,
  HMM0,
  HMM1,
  HMBL,
  VDELP0,
  VDELP1,
  VDELBL,
  RESMP0,
  RESMP1,
  HMOVE,
  HMCLR,
  CXCLR
}

// horizontal scan
const COLORCLOCKS: u32 = 228;
const HBLANK: u32 = 68;
const HSCAN: u32 = 160;

// vertical scan
const VSYNC: u32 = 3;
const VBLANK: u32 = 37;
const OVERSCAN: u32 = 30;
const SCANLINES: u32 = 262; // NTSC

// derived values
const HSTART = HBLANK;
const HEND = COLORCLOCKS;
const VSTART = VBLANK + VSYNC;
const VEND = SCANLINES - OVERSCAN;
const VSCAN = VEND - VSTART;

const bitSet = (byte: u8, pattern: u8): bool => (byte & pattern) === pattern;

const rolloutRight = (byte: u8, offset: u8): bool =>
  bitSet(byte >> offset, 0b00000001);

const rolloutLeft = (byte: u8, offset: u8): bool =>
  bitSet(byte << offset, 0b10000000);

export default class TIA {
  memory: Memory;
  x: u8;
  y: u8;
  display: Array<u8>;
  clock: u32;
  cpu: CPU;
  strobedWSYNC: boolean;

  constructor(memory: Memory, cpu: CPU) {
    this.cpu = cpu;
    // TODO: construct a DataView on Memory for the specific region that holds the TIA registers
    this.memory = memory;
    memory.tia = this;
    this.display = new Array<u8>(VSCAN * HSCAN * 4);
    this.strobedWSYNC = false;
  }

  // intercepts all memory write operations to determine whether
  // any of the special registers have been written to
  memoryWrite(addr: u32): void {
    if (addr == Register.WSYNC) {
      trace("WSYNC strobed, CPU paused");
      this.cpu.paused = true;
    }
    if (addr == Register.VSYNC) {
      // if the VSYNC is written and zero, start a new frame
      if (this.memory.read(Register.VSYNC) == 0) {
        this.clock = 0;
      }
    }
  }

  tick(ticks: u32 = 1): void {
    for (let i: u32 = 0; i < ticks; i++) {
      this.tickOnce();
    }
  }

  isPlayfieldSet(playfieldPixel: u8): bool {
    if (playfieldPixel < 4) {
      if (rolloutRight(this.memory.read(Register.PF0), playfieldPixel + 4)) {
        return true;
      }
    } else if (playfieldPixel < 12) {
      if (rolloutLeft(this.memory.read(Register.PF1), playfieldPixel - 4)) {
        return true;
      }
    } else if (playfieldPixel < 20) {
      if (rolloutRight(this.memory.read(Register.PF2), playfieldPixel - 12)) {
        return true;
      }
    }
    return false;
  }

  tickOnce(): void {
    if (this.clock % 3 === 0) {
      cpu.tick();
    }

    // increment the clock and wrap around at the end of the scan
    this.clock++;
    if (this.clock > SCANLINES * COLORCLOCKS) {
      this.clock = 0;
    }

    // if we are at the start of a new horizontal scanline, remove
    // the WSYNC strobe flag
    if (this.clock % COLORCLOCKS === 0) {
      this.cpu.paused = false;
    }

    // check where we are in the raster scan and paint the display
    const vPos: u32 = this.clock / COLORCLOCKS;
    const hPos: u32 = this.clock % COLORCLOCKS;
    if (vPos >= VSTART && vPos < VEND && hPos >= HSTART && hPos < HEND) {
      // background colour
      let colorIndex = this.memory.read(Register.COLUBK);

      // playfield graphics
      let playfieldPixel: u8 = ((hPos - HSTART) / 4) as u8;
      if (playfieldPixel >= 20) {
        if (bitSet(this.memory.read(Register.CTRLPF), 0b00000001)) {
          playfieldPixel = 39 - playfieldPixel;
        } else {
          playfieldPixel = playfieldPixel - 20;
        }
      }
      colorIndex = this.isPlayfieldSet(playfieldPixel)
        ? this.memory.read(Register.COLUPF)
        : colorIndex;

      const pos = ((vPos - VSTART) * HSCAN + (hPos - HSTART)) * 4;
      const color = PALETTE_NTSC[colorIndex / 2];
      this.display[pos] = ((color & 0xff0000) >> 16) as u8;
      this.display[pos + 1] = ((color & 0x00ff00) >> 8) as u8;
      this.display[pos + 2] = (color & 0x0000ff) as u8;
      this.display[pos + 3] = 255;
    }
  }
}
