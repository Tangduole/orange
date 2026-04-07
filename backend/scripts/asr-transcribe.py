#!/usr/bin/env python3
"""
ASR 语音转文字脚本
支持多种后端：
1. faster-whisper (推荐，需要 pip install)
2. openai-whisper (备选)
3. whisper.cpp (轻量级)
"""

import sys
import json
import argparse
import warnings
import os
warnings.filterwarnings('ignore')

def transcribe_with_faster_whisper(audio_path, model_size='tiny', language='zh', enable_paragraphs=False, min_pause=1.0):
    """使用 faster-whisper 进行语音转文字"""
    from faster_whisper import WhisperModel
    
    # 选择计算类型
    compute_type = 'int8'  # CPU 友好
    
    print(f"[ASR] Loading faster-whisper model: {model_size}", file=sys.stderr)
    model = WhisperModel(model_size, device='auto', compute_type=compute_type)
    
    print(f"[ASR] Transcribing: {audio_path}", file=sys.stderr)
    
    segments, info = model.transcribe(
        audio_path,
        language=language if language != 'auto' else None,
        beam_size=3,
        best_of=3,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500)
    )
    
    print(f"[ASR] Detected language: {info.language}", file=sys.stderr)
    
    if enable_paragraphs:
        text_parts = []
        current_para = []
        last_end = 0
        
        for segment in segments:
            segment_text = segment.text.strip()
            if not segment_text:
                continue
            
            pause_duration = segment.start - last_end
            if pause_duration >= min_pause and current_para:
                text_parts.append(' '.join(current_para))
                current_para = []
            
            current_para.append(segment_text)
            last_end = segment.end
        
        if current_para:
            text_parts.append(' '.join(current_para))
        
        full_text = '\n\n'.join(text_parts)
    else:
        full_text = ' '.join([segment.text.strip() for segment in segments if segment.text.strip()])
    
    return {
        'success': True,
        'text': full_text,
        'language': info.language,
        'language_probability': info.language_probability
    }

def transcribe_with_whisper(audio_path, model_size='base', language='zh', enable_paragraphs=False, min_pause=1.0):
    """使用 openai-whisper 进行语音转文字 (备选)"""
    import whisper
    
    print(f"[ASR] Loading whisper model: {model_size}", file=sys.stderr)
    model = whisper.load_model(model_size)
    
    print(f"[ASR] Transcribing: {audio_path}", file=sys.stderr)
    
    result = model.transcribe(
        audio_path,
        language=language if language != 'auto' else None,
        paragraph=enable_paragraphs
    )
    
    return {
        'success': True,
        'text': result['text'],
        'language': result.get('language', language)
    }

def transcribe(audio_path, model_size='tiny', language='zh', enable_paragraphs=False, min_pause=1.0):
    """自动选择可用的后端"""
    
    # 先尝试 faster-whisper
    try:
        return transcribe_with_faster_whisper(audio_path, model_size, language, enable_paragraphs, min_pause)
    except ImportError:
        pass
    except Exception as e:
        return {'success': False, 'error': str(e)}
    
    # 尝试 openai-whisper
    try:
        import whisper
        return transcribe_with_whisper(audio_path, model_size, language, enable_paragraphs, min_pause)
    except ImportError:
        return {'success': False, 'error': 'No ASR package installed. Install faster-whisper or openai-whisper.'}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def main():
    parser = argparse.ArgumentParser(description='ASR Transcription Tool')
    parser.add_argument('audio_path', help='Path to audio file')
    parser.add_argument('--model', default='tiny', choices=['tiny', 'base', 'small'], help='Model size')
    parser.add_argument('--language', default='zh', help='Language code')
    parser.add_argument('--paragraphs', action='store_true', help='Enable paragraph segmentation')
    parser.add_argument('--min-pause', type=float, default=1.0, help='Minimum pause duration')
    
    args = parser.parse_args()
    
    result = transcribe(
        args.audio_path,
        model_size=args.model,
        language=args.language,
        enable_paragraphs=args.paragraphs,
        min_pause=args.min_pause
    )
    
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
