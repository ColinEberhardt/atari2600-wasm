  processor 6502
  include "vcs.h"
  include "macro.h"

  org  $1000

Start  
  lda #92
  sta COLUPF

  lda #%10010101
  sta PF0
  sta PF1
  sta PF2
  lda #%00000000
  sta CTRLPF

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
  REPEAT 192
    inx
    stx COLUBK
    sta WSYNC
  REPEND

; Enable VBLANK again
  lda #2
  sta VBLANK
        
; 30 lines of overscan to complete the frame
  REPEAT 30
    sta WSYNC
  REPEND
  
; Go back and do another frame
  jmp NextFrame


  org $1ffc
  .word Start
  .word Start