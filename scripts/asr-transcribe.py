#!/usr/bin/env python3
"""
ASR 转录脚本 - Faster Whisper 本地转录 + 时间戳
"""

import json, sys, argparse
from faster_whisper import WhisperModel

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('audio_path')
    parser.add_argument('--model', default='base')
    parser.add_argument('--language', default='zh')
    parser.add_argument('--word-timestamps', action='store_true', default=True)
    args = parser.parse_args()

    model = WhisperModel(args.model, device="auto", compute_type="default")
    segments, info = model.transcribe(
        args.audio_path,
        language=args.language,
        word_timestamps=True,
        vad_filter=True
    )
    
    all_segments = list(segments)
    text = ''.join(s.text for s in all_segments).strip()
    
    result = {
        'success': True,
        'text': text,
        'language': info.language,
        'duration': info.duration,
        'segments': [
            {'start': float(s.start), 'end': float(s.end), 'text': s.text.strip()}
            for s in all_segments if s.text.strip()
        ]
    }
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
