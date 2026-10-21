import sys
import torch

def convert_llm(state_dict):
    # 调整了lm的结构，把codec_lm.encoder作为llm，codec_lm.decoder作为decoder
    keys = list(state_dict.keys())
    for k in keys:
        if k.startswith('codec_lm.encoder.'):
            v = state_dict.pop(k)
            k = k.replace('codec_lm.encoder.', 'llm.')
            state_dict[k] = v
        if k.startswith('codec_lm.decoder.'):
            v = state_dict.pop(k)
            k = k.replace('codec_lm.decoder.', 'llm_decoder.')
            state_dict[k] = v
    # espnet和wenet具体实现上的差异
    keys = list(state_dict.keys())
    for k in keys:
        if k.startswith('text_encoder.embed.'):
            v = state_dict.pop(k)
            k = k.replace('text_encoder.embed.', 'text_encoder.embed.out.')
            state_dict[k] = v
        if k.startswith('llm.embed.'):
            v = state_dict.pop(k)
            k = k.replace('llm.embed.', 'llm.embed.out.')
            state_dict[k] = v
    keys = list(state_dict.keys())
    for k in keys:
        if k.startswith('text_enc_out_layer.'):
            v = state_dict.pop(k)
            k = k.replace('text_enc_out_layer.', 'text_encoder_affine_layer.')
            state_dict[k] = v
        if k.startswith('token_embedding.'):
            v = state_dict.pop(k)
            k = k.replace('token_embedding.', 'text_embedding.')
            state_dict[k] = v
        if k.startswith('xvec_proj.'):
            v = state_dict.pop(k)
            k = k.replace('xvec_proj.', 'spk_embed_affine_layer.')
            state_dict[k] = v
        if k.startswith('lm_embedding.'):
            v = state_dict.pop(k)
            k = k.replace('lm_embedding.', 'llm_embedding.')
            state_dict[k] = v
        if k.startswith('codec_embedder.'):
            v = state_dict.pop(k)
            k = k.replace('codec_embedder.', 'speech_embedding.')
            state_dict[k] = v
    # instruct少了spk embedding参数，加个全0上去
    keys = list(state_dict.keys())
    if 'spk_embed_affine_layer.weight' not in keys:
        print('no spk_embed_affine_layer.weight, should be instruct model')
        state_dict['spk_embed_affine_layer.weight'] = torch.zeros(1024, 192)
    if 'spk_embed_affine_layer.bias' not in keys:
        print('no spk_embed_affine_layer.bias, should be instruct model')
        state_dict['spk_embed_affine_layer.bias'] = torch.zeros(1024)
    return state_dict

def convert_hift(state_dict):
    # 调整了cosyvoice中hifigan的结构，把f0_predictor放到generator里
    state_dict = {k: v for k, v in state_dict.items() if not k.startswith('discriminator.')}
    keys = list(state_dict.keys())
    for k in keys:
        if k in ['step', 'epoch']:
            del state_dict[k]
        if k.startswith('decoder.'):
            v = state_dict.pop(k)
            k = k.replace('decoder.', '')
            state_dict[k] = v
        if k.startswith('generator.'):
            v = state_dict.pop(k)
            k = k.replace('generator.', '')
            state_dict[k] = v
    return state_dict

def convert_flow(state_dict):
    keys = list(state_dict.keys())
    for k in keys:
        if k.startswith('encoder.embed.'):
            v = state_dict.pop(k)
            k = k.replace('encoder.embed.', 'encoder.embed.out.')
            state_dict[k] = v
    for k in keys:
        if k.startswith('xvec_proj.'):
            v = state_dict.pop(k)
            k = k.replace('xvec_proj.', 'spk_embed_affine_layer.')
            state_dict[k] = v
    return state_dict

def convert_llm2(state_dict):
    # 调整了lm的结构，把codec_lm.encoder作为llm，codec_lm.decoder作为decoder
    keys = list(state_dict.keys())
    for k in keys:
        if k.startswith('codec_lm.encoder.'):
            v = state_dict.pop(k)
            k = k.replace('codec_lm.encoder.', 'llm.')
            state_dict[k] = v
        if k.startswith('codec_lm.decoder.'):
            v = state_dict.pop(k)
            k = k.replace('codec_lm.decoder.', 'llm_decoder.')
            state_dict[k] = v
        if k.startswith('lm_embedding.'):
            v = state_dict.pop(k)
            k = k.replace('lm_embedding.', 'llm_embedding.')
            state_dict[k] = v
        if k.startswith('codec_embedder.'):
            v = state_dict.pop(k)
            k = k.replace('codec_embedder.', 'speech_embedding.')
            state_dict[k] = v
        if k.startswith('text_enc_out_layer.'):
            state_dict.pop(k)
        if k.startswith('token_embedding.weight'):
            state_dict.pop(k)
    return state_dict

def convert_llm3(state_dict):
    # 调整了lm的结构，把codec_lm.encoder作为llm，codec_lm.decoder作为decoder
    keys = list(state_dict.keys())
    state_dict = {k: v for k, v in state_dict.items() if (not k.startswith('reward') and not k.startswith('ref'))}
    for k in keys:
        if k.startswith('llm.model.'):
            v = state_dict.pop(k)
            k = k.replace('llm.model.', 'llm.model.model.')
            state_dict[k] = v
        if k.startswith('codec_head.'):
            v = state_dict.pop(k)
            state_dict[k.replace('codec_head.', 'llm_decoder.')] = v
        if k.startswith('codec_embed.'):
            v = state_dict.pop(k)
            k = k.replace('codec_embed.', 'speech_embedding.')
            state_dict[k] = v
    state_dict['llm.model.lm_head.weight'] = state_dict['llm.model.model.embed_tokens.weight']
    return state_dict

def convert_flow2(state_dict):
    keys = list(state_dict.keys())
    for k in keys:
        if k.startswith('encoder.embed.'):
            v = state_dict.pop(k)
            k = k.replace('encoder.embed.', 'encoder.embed.out.')
            state_dict[k] = v
    for k in keys:
        if k.startswith('xvec_proj.'):
            v = state_dict.pop(k)
            k = k.replace('xvec_proj.', 'spk_embed_affine_layer.')
            state_dict[k] = v
    for k in keys:
        if k.startswith('mel_extractor.'):
            state_dict.pop(k)
    for k in keys:
        if k.startswith('encoder.upsample_blocks.0.0.'):
            v = state_dict.pop(k)
            k = k.replace('encoder.upsample_blocks.0.0.', 'encoder.up_layer.')
            state_dict[k] = v
        if k.startswith('encoder.upsample_blocks.0.1.'):
            v = state_dict.pop(k)
            k = k.replace('encoder.upsample_blocks.0.1.', 'encoder.up_embed.out.')
            state_dict[k] = v
        if k.startswith('encoder.upsample_blocks.0.2.'):
            v = state_dict.pop(k)
            k = k.replace('encoder.upsample_blocks.0.2.', 'encoder.up_encoders.')
            state_dict[k] = v
        # CausalBlock1D中sequantial 1->2
        if k.startswith('decoder.estimator.') and k.endswith('block.1.weight'):
            v = state_dict.pop(k)
            k = k.replace('block.1.weight', 'block.2.weight')
            state_dict[k] = v
        if k.startswith('decoder.estimator.') and k.endswith('block.1.bias'):
            v = state_dict.pop(k)
            k = k.replace('block.1.bias', 'block.2.bias')
            state_dict[k] = v
    return state_dict

def convert_flow3(state_dict):
    keys = list(state_dict.keys())
    for k in keys:
        if k.startswith('xvec_proj.'):
            v = state_dict.pop(k)
            k = k.replace('xvec_proj.', 'spk_embed_affine_layer.')
            state_dict[k] = v
        if k.startswith('codec_embedder.'):
            v = state_dict.pop(k)
            k = k.replace('codec_embedder.', 'input_embedding.')
            state_dict[k] = v
        if k.startswith('lookahead_conv1d.'):
            v = state_dict.pop(k)
            k = k.replace('lookahead_conv1d.', 'pre_lookahead_layer.')
            state_dict[k] = v
    for k in keys:
        if k.startswith('mel_extractor.'):
            state_dict.pop(k)
    for k in keys:
        # CausalBlock1D中sequantial 1->2
        if k.startswith('dit_model.'):
            v = state_dict.pop(k)
            k = k.replace('dit_model.', 'decoder.estimator.')
            state_dict[k] = v
        if k in ['epoch', 'step']:
            state_dict.pop(k)
    return state_dict

if __name__ == '__main__':
    # 使用方法 python3 convert.py 原格式llm.pt llm 新格式llm.pt
    state_dict = torch.load(sys.argv[1], map_location='cpu')
    if 'state_dict' in state_dict:
        state_dict = state_dict['state_dict']
    if sys.argv[2] == 'llm':
        state_dict = convert_llm(state_dict)
    elif sys.argv[2] == 'flow':
        state_dict = convert_flow(state_dict)
    elif sys.argv[2] == 'hift':
        state_dict = convert_hift(state_dict)
    elif sys.argv[2] == 'llm2':
        state_dict = convert_llm2(state_dict)
    elif sys.argv[2] == 'llm3':
        state_dict = convert_llm3(state_dict)
    elif sys.argv[2] == 'flow2':
        state_dict = convert_flow2(state_dict)
    elif sys.argv[2] == 'flow3':
        state_dict = convert_flow3(state_dict)
    else:
        raise ValueError
    torch.save(state_dict, sys.argv[3])
