const HARD_END = /[。！？!?；;…\n]/;
const SOFT_END = /[，,、：:]/;
const MARKUP = /[*#`_~>|]/g;

/**
 * 把模型流式吐出的文字切成能单独合成的句子，边想边说。
 * 句号类标点一定切；逗号类在攒够 softMin 个字后才切，避免一字一顿。
 */
export class SentenceSplitter {
  private buffer = "";

  constructor(private readonly softMin = 16) {}

  push(text: string): string[] {
    this.buffer += text.replace(MARKUP, "");
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i]!;
      const hard = HARD_END.test(ch);
      if (!hard && !(SOFT_END.test(ch) && i + 1 - start >= this.softMin)) continue;
      const sentence = this.buffer.slice(start, i + 1).trim();
      if (hasWords(sentence)) out.push(sentence);
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return hasWords(rest) ? [rest] : [];
  }
}

function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
