# wnacg expanded interface demonstration

This replaces the earlier three-to-four-scene, 2x demo with **10 recorded scenes** from the actual production frontend at `062e0a39c70cc7b37872863ae34e9ba538e2a0e2`.

**Pacing:** every source action interval is played at **10x**, followed by a **0.8-second result hold**. The final clip lasts 20.40 seconds; it is not a uniformly accelerated full video. The GIF and MP4 share the same timing. The fast-forward and sample-data labels remain visible.

**Scope:** Reading UI · original local pages · no upstream content or AI. The browser harness substitutes native API boundaries with original local examples; this is not native macOS/Windows end-to-end validation. No user credentials, personal files, live provider output or upstream comic content are included. Satori question composition is shown without submitting an AI request; no answer is fabricated.

## Scenes

1. 01 / Continuous reading / 连续阅读，顺着往下看
2. 02 / Wide reading layout / 宽屏阅读，多留一点空间
3. 03 / Edge-to-edge layout / 贴边模式，把页面铺开
4. 04 / Compact page spacing / 收紧图片间距，阅读更连贯
5. 05 / Single-page reading / 切成单页，专注眼前这一张
6. 06 / Page navigation / 用按钮翻到下一页
7. 07 / Zoom into the artwork / 放大局部，细节看得更清楚
8. 08 / Reset the reading zoom / 一键恢复原始比例
9. 09 / Two-page spread / 双页并排，换一种阅读节奏
10. 10 / Restore a comfortable reading layout / 宽度与留白，各自按习惯来

## Files

`preview.gif` is the inline README preview; `demo.mp4` is the complete silent H.264 video. `poster.png` is an actual recorded result frame. `provenance.json` records source, pacing, scene boundaries and media hashes.

The reproducible documentation-only recorder is `yuxino/kiri/docs/demos/capture/expanded.py`. It is not loaded by the applications. The shipped application code, versions, signing and update workflows remain unchanged.
