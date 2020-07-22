  processor 6502
  include "vcs.h"
  include "macro.h"

  org  $1000

Start  
  lda #$FF
  sta COLUBK
  lda #$F0
  sta COLUPF

NextFrame
; Enable VBLANK (disable output)
  lda #2
  sta VBLANK
        
; At the beginning of the frame we set the VSYNC bit...
  lda #2
  sta VSYNC
        
; And hold it on for 3 scanlines...
  REPEAT 3
    sta WSYNC
  REPEND
        
; Now we turn VSYNC off.
  lda #0
  sta VSYNC

; Now we need 37 lines of VBLANK...
  REPEAT 37
    sta WSYNC  ; accessing WSYNC stops the CPU until next scanline
  REPEND

; Re-enable output (disable VBLANK)
  lda #0
  sta VBLANK
        
; 192 scanlines are visible
; We'll draw some rainbows
  ldx #0
  ldy #192
ScanLoop
  sta WSYNC
  lda PFBitmap0,y
  sta PF0		; store first playfield byte
	lda PFBitmap1,y
  sta PF1		; store 2nd byte
	lda PFBitmap2,y
  sta PF2		; store 3rd byte
  nop
  nop
  nop		; pause to let playfield finish drawing
	lda PFBitmap3,y
  sta PF0		; store 4th byte
	lda PFBitmap4,y
  sta PF1		; store 5th byte
	lda PFBitmap5,y
  sta PF2		; store 6th byte

  dey 
  bne ScanLoop	; repeat until all scanlines drawn

; Enable VBLANK again
  lda #2
  sta VBLANK
        
; 30 lines of overscan to complete the frame
  REPEAT 30
    sta WSYNC
  REPEND
  
; Go back and do another frame
  jmp NextFrame

PFBitmap0
	hex 00
	hex a070d0b0d0b0e050f0d0b0f050f060b0
	hex f0d070b060f050f0a0f050f050f0d070
	hex d0b0d0b0d0b050f050f0a0f0a0f060b0
	hex e0b0e0d0f0d0b0f0a070d070d0b0e0b0
	hex 60f0a0f050f0b0d0f0d0f0d0f0d0f0f0
	hex e0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0
	hex f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0
	hex f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0
	hex f0f0e0f0f0f0e0f0f0f0f0d0f0f0e0f0
	hex d0f0b0f070b0f0d0f0d0b0d0f0d0b0d0
	hex f0d0b0f0a0f0e0b0e050f0d0b070a0f0
	hex b0b0e0b070d070f050f0b0f060f0b0f0
PFBitmap1
	hex 00
	hex fedf7fdf7fdfbeffde7ffe5fff5fffaf
	hex 77b7dfafff5fef7faf77ef5ff7ae7fae
	hex f75eef7aaff6dfb7de775ff65ff6affe
	hex aeff5efe5efebe7efefefffefe7efefe
	hex fefefefefefefefefdfefefefefefefe
	hex fcfef6fefcfefefefef6fef6fef6eef7
	hex eefeeffffffffeffbfffffdfffdeffdf
	hex fefefffeff7fffffffbfffbfbfbfbe9f
	hex bfbfffffffffffffffffffffffffffff
	hex fffffffffbffbdf75ff55ff56ff55ff5
	hex 5ff55ff55ff55ef75af7de75dff5de77
	hex de75dff5dffbaefbaffb6edbbeef55ff
PFBitmap2
	hex 00
	hex 375f555f2f55975b4729430103000101
	hex 00010000010000000000000001000108
	hex 05040a0409040414242834041c040e06
	hex 04020200010401040406140a1a0c0a05
	hex 04010001000001000000000000000000
	hex 00000000000000000000000081020104
	hex 050e060d8e0d0f0f070605800009060e
	hex 85060404040406070303030000000000
	hex 00000000000000000000000100010001
	hex 01010101010101030303030703030706
	hex 070d0f0a1b1307050b9ff5f7f7e5cf8d
	hex 1f153e7bf6fbfdd7fab7bdf7adffaaff
PFBitmap3
	hex 00
	hex f0f0f0f0e0f0e0e0d0a0d0a0d0c0d0c0
	hex c0a08080408000808080808000000000
	hex 00000000000080008000800080808000
	hex 80808000808080008000800080000000
	hex 00000000000000000000000000000000
	hex 0000000080c0104040e0c0c0e0c0e0c0
	hex 70e060a000804090706050200090a0c0
	hex e0706030000000000000000000000000
	hex 00000000000000000000000000000000
	hex 00000000000000000000000000008080
	hex 80400000808080c0e0f0f0f0f0f07030
	hex 00000080f0f0f0f0f0f0f0f0f0f0e0f0
PFBitmap4
	hex 00
	hex fffffffffbfffbfffdfffffefffffeff
	hex ffffffffffffffffffffffffffffff7f
	hex ffffffffffffffffffffffffffffffff
	hex ffffffffffffffffffffffffffffffff
	hex ffffffffffffff7fff7fff7f7f7f7f7f
	hex 7f7f7f7f7f3d7fbfbfffbfbf3fbf3d1f
	hex 3f1f3f1f3f1f1f3f1f5f1f9f1f9f1f1f
	hex 1f1f1f0f1f0f1f1f1f1f3f1f3f1f3f3f
	hex 3f3f3f3e3e3f3f3f7e3c7c3c7d3c7c38
	hex 7879797872787270f262e0e3c3cb9b39
	hex 327a79fafafaf0e1e1e0c185cd0c9d3c
	hex 3efeffffffffffffffffffffffffffff
PFBitmap5
	hex 00
	hex ffffffffffffffffffffffffffffffff
	hex fffffeffffffffffffffffffffffffff
	hex fffffffffbffffffffffffffffffffff
	hex ffffffffffffffffffffffffffffffff
	hex ffffffffffffffffffffff7fffffffff
	hex ffffffffffffffffffff7fffffffffff
	hex ffffffffffffffffffffffffffffffff
	hex ffffffffffffffffffbf3f3fbf1fbf9f
	hex bf9efb8ddf9098c1c0c8c1d0b080b080
	hex 9080918ccac4c2c2c2e0c2c2d2808190
	hex 80a0e0f0e0f0f1e2e1c1c0c0e2c1e0e1
	hex e9f9fafafcf8fcfeffffffffffffffff

  org $1ffc
  .word Start
  .word Start