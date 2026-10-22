#!/usr/bin/env bash
# 只读审计 GPU 服务器。不安装、不修改、不重启任何服务。
# 用法：bash deploy/gpu-server/audit.sh [输出文件]
# 建议先 scp 到服务器，或直接 ssh 'bash -s' < audit.sh
set -uo pipefail

OUT="${1:-$HOME/karen-gpu-audit-$(date +%Y%m%d-%H%M%S).txt}"
mkdir -p "$(dirname "$OUT")" 2>/dev/null || true
exec > >(tee "$OUT") 2>&1

section() { printf '\n\n========== %s ==========\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

section "基本信息"
date -Is
whoami
id
uname -a
cat /etc/os-release 2>/dev/null || true
printf 'CPU: '; nproc 2>/dev/null || true
lscpu 2>/dev/null | grep -E 'Model name|Socket|Core|Thread|NUMA|MHz' | head -20 || true

section "内存"
free -h 2>/dev/null || true

section "磁盘"
df -hT 2>/dev/null || true
echo '--- block devices ---'
lsblk -o NAME,SIZE,ROTA,TYPE,MODEL,MOUNTPOINT 2>/dev/null || true
echo '--- large filesystems (>500G) ---'
df -hT 2>/dev/null | awk 'NR==1 || $3 ~ /T$/ || $3 ~ /[5-9][0-9][0-9]G/' || true

section "GPU"
if have nvidia-smi; then
  nvidia-smi
  echo '--- query ---'
  nvidia-smi --query-gpu=index,name,memory.total,memory.used,driver_version,compute_cap,power.limit,power.draw --format=csv 2>/dev/null || true
  echo '--- topology ---'
  nvidia-smi topo -m 2>/dev/null || true
  echo '--- nvlink ---'
  nvidia-smi nvlink -s 2>/dev/null || true
else
  echo 'nvidia-smi not found (driver missing?)'
fi

section "CUDA / 编译环境"
have nvcc && nvcc --version || echo 'nvcc not found'
ls -d /usr/local/cuda* 2>/dev/null || true
have gcc && gcc --version | head -1 || true
have cmake && cmake --version | head -1 || true

section "Docker / NVIDIA Container Toolkit"
if have docker; then
  docker version --format 'client={{.Client.Version}} server={{.Server.Version}}' 2>/dev/null || docker version 2>/dev/null || true
  docker info --format '{{json .Runtimes}}' 2>/dev/null || true
else
  echo 'docker not found'
fi
have nvidia-ctk && nvidia-ctk --version || echo 'nvidia-ctk not found'
dpkg -l 2>/dev/null | grep -iE 'nvidia-container|nvidia-docker' || true

section "Python / 媒体工具"
have python3 && python3 --version || true
have pip3 && pip3 --version || true
have uv && uv --version || true
have ffmpeg && ffmpeg -version | head -1 || echo 'ffmpeg not found'
have git && git --version || true
have git-lfs && git lfs version || true
have aria2c && aria2c --version | head -1 || true
have hf && hf --version || true

section "网络"
ip -brief addr 2>/dev/null || ifconfig 2>/dev/null || true
echo '--- DNS ---'
getent hosts huggingface.co 2>/dev/null || true
echo '--- HF HEAD ---'
curl -sSI --max-time 10 https://huggingface.co 2>&1 | head -3 || true
echo '--- hf-mirror HEAD ---'
curl -sSI --max-time 10 https://hf-mirror.com 2>&1 | head -3 || true
echo '--- github HEAD ---'
curl -sSI --max-time 10 https://github.com 2>&1 | head -3 || true

section "端口占用（18100-18130 / 7687 / 7474）"
if have ss; then
  ss -lntp 2>/dev/null | awk 'NR==1 || $4 ~ /:(181[0-2][0-9]|7687|7474)$/' || true
else
  netstat -lntp 2>/dev/null | awk 'NR==1 || $4 ~ /:(181[0-2][0-9]|7687|7474)$/' || true
fi

section "防火墙"
if have ufw; then ufw status 2>/dev/null || true; fi
if have firewall-cmd; then firewall-cmd --state 2>/dev/null || true; fi
if have iptables; then iptables -S 2>/dev/null | head -30 || true; fi

section "systemd / 服务"
if have systemctl; then
  systemctl is-active docker 2>/dev/null || true
  systemctl --no-pager --type=service --state=running 2>/dev/null | head -20 || true
fi

section "权限 / sudo"
if sudo -n true 2>/dev/null; then echo 'passwordless sudo: yes'; else echo 'passwordless sudo: no/unknown'; fi

section "审计结论提示"
GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || true)
if [ -n "${GPU_MEM:-}" ]; then
  echo "单卡显存: ${GPU_MEM} MiB"
  if [ "$GPU_MEM" -lt 80000 ] 2>/dev/null; then
    echo 'WARN: 单卡显存 < 80GB，Qwen-Image-Edit-2511 需要重新估算（可能需量化/换模型）。'
  fi
else
  echo 'WARN: 读不到 GPU 显存。'
fi
ROOT_AVAIL=$(df -Pk / 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "${ROOT_AVAIL:-}" ] && [ "$ROOT_AVAIL" -lt 500000000 ] 2>/dev/null; then
  echo 'WARN: 根分区可用 < 500GB；模型+训练数据建议至少 1–2TB。'
fi
have docker || echo 'WARN: 未装 Docker。'
have ffmpeg || echo 'WARN: 未装 ffmpeg。'

printf '\n审计完成。输出已保存：%s\n' "$OUT"
