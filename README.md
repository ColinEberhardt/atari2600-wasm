# WebAssembly / AssemblyScript Atari 2600 Emulator 

I've been fascinated with the 2600 ever since reading [Racing the Beam](https://www.amazon.co.uk/Racing-Beam-Computer-Platform-Studies/dp/026201257X), the idea of a computer that doesn't have enough memory to support video RAM is just nuts! This project is an excuse to have a play with [AssemblyScript](https://docs.assemblyscript.org/), and explore the 2600 further.

I'm implementing the 2600 by implementing features as they appear in the [Atari 2600 Programming for Newbies](https://cdn.hackaday.io/files/1646277043401568/Atari_2600_Programming_for_Newbies_Revised_Edition.pdf) guide.




## Progress

 - [Atari 2600 Programming for Newbies](https://cdn.hackaday.io/files/1646277043401568/Atari_2600_Programming_for_Newbies_Revised_Edition.pdf)
  - [x] Session 1: Start Here
  - [x] Session 2: Television Display Basics
  - [x] Session 3: The TIA and 6502
  - [x] Session 4: The TIA
  - [x] Session 5: Memory Architecture
  - [x] Sessions 6 & 7: The TV and our Kernel
  - [x] Session 8: Our First Kernel
  - [x] Session 9: 6502 and DASM – Assembling the basics
  - [x] Session 10: Orgasm
  - [x] Session 11: Colorful colors
  - [x] Session 12: Initialization
  - [ ] Session 13: Playfield Basics

## CPU Instructions

 - from: http://www.obelisk.me.uk/6502/reference.html

 - [x] ADC
 - [ ] AND
 - [ ] ASL
 - [ ] BCC
 - [ ] BCS
 - [ ] BEQ
 - [ ] BIT
 - [ ] BMI
 - [x] BNE
 - [ ] BPL
 - [ ] BRK
 - [ ] BVC
 - [ ] BVS
 - [ ] CLC
 - [ ] CLD
 - [ ] CLI
 - [ ] CLV
 - [ ] CMP
 - [ ] CPX
 - [ ] CPY
 - [ ] DEC
 - [ ] DEX
 - [x] DEY
 - [ ] EOR
 - [ ] INC
 - [x] INX
 - [x] INY
 - [o] JMP - absolute mode only
 - [ ] JSR
 - [o] LDA - immediate mode only
 - [o] LDX - immediate mode only
 - [o] LDY - immediate mode only
 - [o] LSR - accumulator mode only
 - [x] NOP
 - [ ] ORA
 - [ ] PHA
 - [ ] PHP
 - [ ] PLA
 - [ ] PLP
 - [ ] ROL
 - [ ] ROR
 - [ ] RTI
 - [ ] RTS
 - [ ] SBC
 - [ ] SEC
 - [ ] SED
 - [ ] SEI
 - [o] STA - zero page only
 - [o] STX - zero page only
 - [o] STY - zero page only
 - [ ] TAX
 - [ ] TAY
 - [ ] TSX
 - [ ] TXA
 - [ ] TXS
 - [ ] TYA


