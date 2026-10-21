# 本地补丁：上游 __init__ 会连带导入 wandb/gradio/rootutils 等训练期依赖，
# 推理只需要 pylogger。保留空文件避免重依赖。
