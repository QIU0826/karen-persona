# Copyright (c) 2024 Alibaba Inc (authors: Xiang Lyu, Liu Yue)
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
import spaces
import os
import sys
import argparse
import gradio as gr
import numpy as np
import torch
import torchaudio
import random
import librosa
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.append('{}/third_party/Matcha-TTS'.format(ROOT_DIR))

from modelscope import snapshot_download, HubApi
from huggingface_hub import snapshot_download as hf_snapshot_download

hf_snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B-2512', local_dir='pretrained_models/Fun-CosyVoice3-0.5B')
snapshot_download('iic/SenseVoiceSmall', local_dir='pretrained_models/SenseVoiceSmall')
hf_snapshot_download('FunAudioLLM/CosyVoice-ttsfrd', local_dir='pretrained_models/CosyVoice-ttsfrd')
os.system(
    "cd pretrained_models/CosyVoice-ttsfrd/ && "
    "pip install ttsfrd_dependency-0.1-py3-none-any.whl && "
    "pip install ttsfrd-0.4.2-cp310-cp310-linux_x86_64.whl && "
    "apt install -y unzip && "
    "rm -rf resource && "
    "unzip resource.zip -d ."
)

from cosyvoice.cli.cosyvoice import AutoModel as CosyVoiceAutoModel
from cosyvoice.utils.file_utils import logging, load_wav
from cosyvoice.utils.common import set_all_random_seed, instruct_list

# -----------------------------
# i18n (En: British spelling)
# -----------------------------
LANG_EN = "En"
LANG_ZH = "Zh"

MODE_ZERO_SHOT = "zero_shot"
MODE_INSTRUCT = "instruct"

UI_TEXT = {
    LANG_EN: {
        "lang_label": "Language",
        "md_links": (
            "### Repository [CosyVoice](https://github.com/FunAudioLLM/CosyVoice)  \n"
            "Pre-trained model [Fun-CosyVoice3-0.5B](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)  \n"
            "[CosyVoice2-0.5B](https://www.modelscope.cn/models/iic/CosyVoice2-0.5B)  \n"
            "[CosyVoice-300M](https://www.modelscope.cn/models/iic/CosyVoice-300M)  \n"
            "[CosyVoice-300M-Instruct](https://www.modelscope.cn/models/iic/CosyVoice-300M-Instruct)  \n"
            "[CosyVoice-300M-SFT](https://www.modelscope.cn/models/iic/CosyVoice-300M-SFT)"
        ),
        "md_hint": "#### Enter the text to synthesise, choose an inference mode, and follow the steps.",
        "tts_label": "Text to synthesise",
        "tts_default": "Her handwriting is very neat, which suggests she likes things tidy.",
        "mode_label": "Inference mode",
        "mode_zero_shot": "3s fast voice cloning",
        "mode_instruct": "Natural language control",
        "steps_label": "Steps",
        "steps_zero_shot": (
            "1. Choose a prompt audio file, or record prompt audio (≤ 30s). If both are provided, the uploaded file is used.\n"
            "2. Enter the prompt text.\n"
            "3. Click Generate audio."
        ),
        "steps_instruct": (
            "1. Choose a prompt audio file, or record prompt audio (≤ 30s). If both are provided, the uploaded file is used.\n"
            "2. Choose/enter the instruct text.\n"
            "3. Click Generate audio."
        ),
        "stream_label": "Streaming inference",
        "stream_no": "No",
        "dice": "🎲",
        "seed_label": "Random inference seed",
        "upload_label": "Choose prompt audio file (sample rate ≥ 16 kHz)",
        "record_label": "Record prompt audio",
        "prompt_text_label": "Prompt text",
        "prompt_text_ph": "Enter prompt text (auto recognition supported; you can edit the result)...",
        "instruct_label": "Choose instruct text",
        "generate_btn": "Generate audio",
        "output_label": "Synthesised audio",
        "warn_too_long": "Your input text is too long; please keep it within 200 characters.",
        "warn_instruct_empty": "You are using Natural language control; please enter instruct text.",
        "info_instruct_need_prompt": "You are using Natural language control; please provide prompt audio.",
        "warn_prompt_missing": "Prompt audio is empty. Did you forget to provide prompt audio?",
        "warn_prompt_sr_low": "Prompt audio sample rate {} is below {}.",
        "warn_prompt_too_long_10s": "Please keep the prompt audio within 10 seconds to avoid poor inference quality.",
        "warn_prompt_text_missing": "Prompt text is empty. Did you forget to enter prompt text?",
        "info_instruct_ignored": "You are using 3s fast voice cloning; instruct text will be ignored.",
        "warn_invalid_mode": "Invalid mode selection.",
    },
    LANG_ZH: {
        "lang_label": "语言",
        "md_links": (
            "### 代码库 [CosyVoice](https://github.com/FunAudioLLM/CosyVoice)  \n"
            "预训练模型 [Fun-CosyVoice3-0.5B](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)  \n"
            "[CosyVoice2-0.5B](https://www.modelscope.cn/models/iic/CosyVoice2-0.5B)  \n"
            "[CosyVoice-300M](https://www.modelscope.cn/models/iic/CosyVoice-300M)  \n"
            "[CosyVoice-300M-Instruct](https://www.modelscope.cn/models/iic/CosyVoice-300M-Instruct)  \n"
            "[CosyVoice-300M-SFT](https://www.modelscope.cn/models/iic/CosyVoice-300M-SFT)"
        ),
        "md_hint": "#### 请输入需要合成的文本，选择推理模式，并按照提示步骤进行操作",
        "tts_label": "输入合成文本",
        "tts_default": "Her handwriting is [M][AY0][N][UW1][T]并且很整洁，说明她[h][ào]干净。",
        "mode_label": "选择推理模式",
        "mode_zero_shot": "3s极速复刻",
        "mode_instruct": "自然语言控制",
        "steps_label": "操作步骤",
        "steps_zero_shot": (
            "1. 选择prompt音频文件，或录入prompt音频，注意不超过30s，若同时提供，优先选择prompt音频文件\n"
            "2. 输入prompt文本\n"
            "3. 点击生成音频按钮"
        ),
        "steps_instruct": (
            "1. 选择prompt音频文件，或录入prompt音频，注意不超过30s，若同时提供，优先选择prompt音频文件\n"
            "2. 输入instruct文本\n"
            "3. 点击生成音频按钮"
        ),
        "stream_label": "是否流式推理",
        "stream_no": "否",
        "dice": "🎲",
        "seed_label": "随机推理种子",
        "upload_label": "选择prompt音频文件，注意采样率不低于16khz",
        "record_label": "录制prompt音频文件",
        "prompt_text_label": "prompt文本",
        "prompt_text_ph": "请输入prompt文本，支持自动识别，您可以自行修正识别结果...",
        "instruct_label": "选择instruct文本",
        "generate_btn": "生成音频",
        "output_label": "合成音频",
        "warn_too_long": "您输入的文字过长，请限制在200字以内",
        "warn_instruct_empty": "您正在使用自然语言控制模式, 请输入instruct文本",
        "info_instruct_need_prompt": "您正在使用自然语言控制模式, 请输入prompt音频",
        "warn_prompt_missing": "prompt音频为空，您是否忘记输入prompt音频？",
        "warn_prompt_sr_low": "prompt音频采样率{}低于{}",
        "warn_prompt_too_long_10s": "请限制输入音频在10s内，避免推理效果过低",
        "warn_prompt_text_missing": "prompt文本为空，您是否忘记输入prompt文本？",
        "info_instruct_ignored": "您正在使用3s极速复刻模式，instruct文本会被忽略！",
        "warn_invalid_mode": "无效的模式选择",
    },
}


def t(lang: str, key: str) -> str:
    lang = lang if lang in UI_TEXT else LANG_ZH
    return UI_TEXT[lang][key]


def mode_choices(lang: str):
    return [
        (t(lang, "mode_zero_shot"), MODE_ZERO_SHOT),
        (t(lang, "mode_instruct"), MODE_INSTRUCT),
    ]


def steps_for(lang: str, mode_value: str) -> str:
    if mode_value == MODE_INSTRUCT:
        return t(lang, "steps_instruct")
    return t(lang, "steps_zero_shot")


# -----------------------------
# Audio post-process
# -----------------------------
max_val = 0.8
top_db = 60
hop_length = 220
win_length = 440


def generate_seed():
    seed = random.randint(1, 100000000)
    return {"__type__": "update", "value": seed}


def postprocess(wav):
    speech = load_wav(wav, target_sr=target_sr, min_sr=16000)
    speech, _ = librosa.effects.trim(
        speech, top_db=top_db, frame_length=win_length, hop_length=hop_length
    )
    if speech.abs().max() > max_val:
        speech = speech / speech.abs().max() * max_val
    speech = torch.concat([speech, torch.zeros(1, int(target_sr * 0.2))], dim=1)
    torchaudio.save(wav, speech, target_sr)
    return wav

@spaces.GPU
def prompt_wav_recognition(prompt_wav):
    res = asr_model.generate(
        input=prompt_wav,
        language="auto",  # "zn", "en", "yue", "ja", "ko", "nospeech"
        use_itn=True,
    )
    text = res[0]["text"].split("|>")[-1]
    return text


@spaces.GPU
def generate_audio(
    tts_text,
    mode_value,
    prompt_text,
    prompt_wav_upload,
    prompt_wav_record,
    instruct_text,
    seed,
    stream,
    ui_lang,
):
    stream = False

    if len(tts_text) > 200:
        gr.Warning(t(ui_lang, "warn_too_long"))
        return (target_sr, default_data)

    sft_dropdown, speed = "", 1.0

    if prompt_wav_upload is not None:
        prompt_wav = prompt_wav_upload
    elif prompt_wav_record is not None:
        prompt_wav = prompt_wav_record
    else:
        prompt_wav = None

    # instruct mode requirements
    if mode_value == MODE_INSTRUCT:
        if instruct_text == "":
            gr.Warning(t(ui_lang, "warn_instruct_empty"))
            return (target_sr, default_data)
        if prompt_wav is None:
            gr.Info(t(ui_lang, "info_instruct_need_prompt"))
            return (target_sr, default_data)

    # zero-shot requirements
    if mode_value == MODE_ZERO_SHOT:
        if prompt_wav is None:
            gr.Warning(t(ui_lang, "warn_prompt_missing"))
            return (target_sr, default_data)

        import soundfile as _sf
        info = _sf.info(prompt_wav)
        if info.samplerate < prompt_sr:
            gr.Warning(t(ui_lang, "warn_prompt_sr_low").format(info.samplerate, prompt_sr))
            return (target_sr, default_data)

        if info.frames / info.samplerate > 10:
            gr.Warning(t(ui_lang, "warn_prompt_too_long_10s"))
            return (target_sr, default_data)

        if prompt_text == "":
            gr.Warning(t(ui_lang, "warn_prompt_text_missing"))
            return (target_sr, default_data)

        if instruct_text != "":
            gr.Info(t(ui_lang, "info_instruct_ignored"))

    if mode_value == MODE_ZERO_SHOT:
        logging.info("get zero_shot inference request")
        set_all_random_seed(seed)
        speech_list = []
        for i in cosyvoice.inference_zero_shot(
            tts_text,
            "You are a helpful assistant.<|endofprompt|>" + prompt_text,
            postprocess(prompt_wav),
            stream=stream,
            speed=speed,
        ):
            speech_list.append(i["tts_speech"])
        return (target_sr, torch.concat(speech_list, dim=1).numpy().flatten())

    if mode_value == MODE_INSTRUCT:
        logging.info("get instruct inference request")
        set_all_random_seed(seed)
        speech_list = []
        for i in cosyvoice.inference_instruct2(
            tts_text,
            instruct_text,
            postprocess(prompt_wav),
            stream=stream,
            speed=speed,
        ):
            speech_list.append(i["tts_speech"])
        return (target_sr, torch.concat(speech_list, dim=1).numpy().flatten())

    gr.Warning(t(ui_lang, "warn_invalid_mode"))
    return (target_sr, default_data)


def on_mode_change(mode_value, ui_lang):
    return steps_for(ui_lang, mode_value)


def on_language_change(ui_lang, current_mode_value):
    lang = ui_lang if ui_lang in (LANG_EN, LANG_ZH) else LANG_ZH
    return (
        gr.update(value=UI_TEXT[lang]["md_links"]),  # md_links
        gr.update(value=UI_TEXT[lang]["md_hint"]),  # md_hint
        gr.update(label=t(lang, "lang_label")),  # lang_radio label
        gr.update(choices=mode_choices(lang), label=t(lang, "mode_label")),  # mode radio
        gr.update(value=steps_for(lang, current_mode_value), label=t(lang, "steps_label")),  # steps box
        gr.update(
            choices=[(t(lang, "stream_no"), False)],
            label=t(lang, "stream_label"),
            value=False,
        ),  # stream radio
        gr.update(value=t(lang, "dice")),  # seed button text
        gr.update(label=t(lang, "seed_label")),  # seed label
        gr.update(label=t(lang, "tts_label"), value=t(lang, "tts_default")),  # tts textbox
        gr.update(label=t(lang, "upload_label")),  # upload label
        gr.update(label=t(lang, "record_label")),  # record label
        gr.update(label=t(lang, "prompt_text_label"), placeholder=t(lang, "prompt_text_ph")),  # prompt text
        gr.update(label=t(lang, "instruct_label")),  # instruct dropdown
        gr.update(value=t(lang, "generate_btn")),  # generate button
        gr.update(label=t(lang, "output_label")),  # output label
    )


def main():
    with gr.Blocks() as demo:
        md_links = gr.Markdown(UI_TEXT[LANG_ZH]["md_links"])
        md_hint = gr.Markdown(UI_TEXT[LANG_ZH]["md_hint"])

        lang_radio = gr.Radio(
            choices=[LANG_EN, LANG_ZH],
            value=LANG_ZH,
            label=t(LANG_ZH, "lang_label"),
        )

        tts_text = gr.Textbox(
            label=t(LANG_ZH, "tts_label"),
            lines=1,
            value=t(LANG_ZH, "tts_default"),
        )

        with gr.Row():
            mode_radio = gr.Radio(
                choices=mode_choices(LANG_ZH),
                label=t(LANG_ZH, "mode_label"),
                value=MODE_ZERO_SHOT,
            )
            steps_box = gr.Textbox(
                label=t(LANG_ZH, "steps_label"),
                value=steps_for(LANG_ZH, MODE_ZERO_SHOT),
                lines=4,
                interactive=False,
                scale=0.5,
            )
            stream = gr.Radio(
                choices=[(t(LANG_ZH, "stream_no"), False)],
                label=t(LANG_ZH, "stream_label"),
                value=False,
            )
            with gr.Column(scale=0.25):
                seed_button = gr.Button(value=t(LANG_ZH, "dice"))
                seed = gr.Number(value=0, label=t(LANG_ZH, "seed_label"))

        with gr.Row():
            prompt_wav_upload = gr.Audio(
                sources="upload",
                type="filepath",
                label=t(LANG_ZH, "upload_label"),
            )
            prompt_wav_record = gr.Audio(
                sources="microphone",
                type="filepath",
                label=t(LANG_ZH, "record_label"),
            )

        prompt_text = gr.Textbox(
            label=t(LANG_ZH, "prompt_text_label"),
            lines=1,
            placeholder=t(LANG_ZH, "prompt_text_ph"),
            value="",
        )
        instruct_text = gr.Dropdown(
            choices=instruct_list,
            label=t(LANG_ZH, "instruct_label"),
            value=instruct_list[0],
        )

        generate_button = gr.Button(t(LANG_ZH, "generate_btn"))
        audio_output = gr.Audio(
            label=t(LANG_ZH, "output_label"),
            autoplay=True,
            streaming=False,
        )

        seed_button.click(generate_seed, inputs=[], outputs=seed)

        generate_button.click(
            generate_audio,
            inputs=[
                tts_text,
                mode_radio,
                prompt_text,
                prompt_wav_upload,
                prompt_wav_record,
                instruct_text,
                seed,
                stream,
                lang_radio,  # ui_lang
            ],
            outputs=[audio_output],
        )

        mode_radio.change(
            fn=on_mode_change,
            inputs=[mode_radio, lang_radio],
            outputs=[steps_box],
        )

        prompt_wav_upload.change(
            fn=prompt_wav_recognition,
            inputs=[prompt_wav_upload],
            outputs=[prompt_text],
        )
        prompt_wav_record.change(
            fn=prompt_wav_recognition,
            inputs=[prompt_wav_record],
            outputs=[prompt_text],
        )

        lang_radio.change(
            fn=on_language_change,
            inputs=[lang_radio, mode_radio],
            outputs=[
                md_links,
                md_hint,
                lang_radio,
                mode_radio,
                steps_box,
                stream,
                seed_button,
                seed,
                tts_text,
                prompt_wav_upload,
                prompt_wav_record,
                prompt_text,
                instruct_text,
                generate_button,
                audio_output,
            ],
        )

    demo.queue(default_concurrency_limit=4).launch()


if __name__ == "__main__":
    cosyvoice = CosyVoiceAutoModel(
        model_dir="pretrained_models/Fun-CosyVoice3-0.5B",
        load_trt=False,
        fp16=False,
    )
    sft_spk = cosyvoice.list_available_spks()

    for stream in [False]:
        for i, j in enumerate(
            cosyvoice.inference_zero_shot(
                "收到好友从远方寄来的生日礼物，那份意外的惊喜与深深的祝福让我心中充满了甜蜜的快乐，笑容如花儿般绽放。",
                "You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。",
                "zero_shot_prompt.wav",
                stream=stream,
            )
        ):
            continue

    prompt_sr = 16000
    target_sr = 24000
    default_data = np.zeros(target_sr)

    model_dir = "pretrained_models/SenseVoiceSmall"
    asr_model = AutoModel(
        model=model_dir,
        disable_update=True,
        log_level="DEBUG",
        device="cuda:0",
    )

    main()