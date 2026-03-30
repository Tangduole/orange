#!/usr/bin/env python3
"""
ASR 转录脚本 - Faster Whisper 本地转录
支持段落自动分段和标点符号
"""

import json
import argparse
from faster_whisper import WhisperModel

def format_segments(segments, min_pause=1.0):
    """
    根据停顿自动分段落
    min_pause: 最小停顿时间（秒），超过此时间视为新段落
    """
    paragraphs = []
    current_paragraph = []
    last_end = 0
    
    for segment in segments:
        # 检查是否需要开始新段落
        if segment.start - last_end > min_pause and current_paragraph:
            paragraphs.append(''.join(current_paragraph))
            current_paragraph = []
        
        current_paragraph.append(segment.text)
        last_end = segment.end
    
    # 添加最后一段
    if current_paragraph:
        paragraphs.append(''.join(current_paragraph))
    
    return '\n\n'.join(paragraphs)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('audio_path', help='音频文件路径')
    parser.add_argument('--model', default='base', help='模型大小: tiny/base/small/medium/large-v3')
    parser.add_argument('--language', default='zh', help='语言代码')
    parser.add_argument('--paragraphs', action='store_true', help='自动分段落')
    parser.add_argument('--min-pause', type=float, default=1.0, help='最小停顿时间（秒）')
    args = parser.parse_args()

    # 加载模型
    model = WhisperModel(args.model, device="auto", compute_type="default")
    
    # 转录
    segments, info = model.transcribe(
        args.audio_path,
        language=args.language,
        vad_filter=True
    )

    # 收集所有 segments
    all_segments = list(segments)
    
    # 格式化文本
    if args.paragraphs:
        text = format_segments(all_segments, args.min_pause)
    else:
        text = ''.join([segment.text for segment in all_segments]).strip()
    
    # 输出 JSON
    result = {
        'text': text,
        'language': info.language,
        'duration': info.duration
    }
    
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
