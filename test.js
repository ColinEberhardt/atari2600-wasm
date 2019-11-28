var dasm = require("dasm").default;
console.log(dasm);

const src = `
	processor 6502
	org  $f000
	lda #$09	
`;
 
// Run with the source
const result = dasm(src);
 
// Read the output as a binary (Uint8Array array)
const ROM = result.data;
console.log(ROM);