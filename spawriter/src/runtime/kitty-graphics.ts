export function canEmitKittyGraphics(): boolean {
  return process.env.AGENT_GRAPHICS?.includes('kitty') ?? false;
}

export function emitKittyImage(base64: string): void {
  const CHUNK_SIZE = 4096;
  const chunks: string[] = [];
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
    chunks.push(base64.slice(i, i + CHUNK_SIZE));
  }

  if (chunks.length === 1) {
    process.stdout.write(`\x1b_Ga=T,f=100;${chunks[0]}\x1b\\`);
    return;
  }

  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    const control = isFirst ? 'a=T,f=100,m=1' : isLast ? 'm=0' : 'm=1';
    process.stdout.write(`\x1b_G${control};${chunks[i]}\x1b\\`);
  }
}
