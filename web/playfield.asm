
	processor 6502
	include "vcs.h"
	include "macro.h"

	org  $f000

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;	
; We're going to mess with the playfield registers, PF0, PF1 and PF2.
; Between them, they represent 20 bits of bitmap information
; which are replicated over 40 wide pixels for each scanline.
; By changing the registers before each scanline, we can draw bitmaps.
;
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

Counter	equ $81

Start	CLEAN_START

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


; Set foreground color
	lda #$82
        sta COLUPF
; Draw the 192 scanlines
	ldx #192
	lda #0		; changes every scanline
        ;lda Counter    ; uncomment to scroll!
ScanLoop
	sta WSYNC	; wait for next scanline
	sta PF0		; set the PF1 playfield pattern register
	sta PF1		; set the PF1 playfield pattern register
	sta PF2		; set the PF2 playfield pattern register
	stx COLUBK	; set the background color
	adc #1		; increment A
	dex
	bne ScanLoop

; Reenable VBLANK for bottom (and top of next frame)
	lda #2
        sta VBLANK

        
; 30 lines of overscan
	ldx #30
LVOver	sta WSYNC
	dex
	bne LVOver
	
; Go back and do another frame
	inc Counter
	jmp NextFrame
	
	org $fffc
	.word Start
	.word Start
