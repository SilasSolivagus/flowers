"""睡着的夹具：证明 `renderFlowchart` 的超时是**真的**把它杀了，而不是等它自己醒。

用法与 flowlayout.py 同形（`input.mmd -o out.svg`），但永不产出。
"""
import sys
import time

try:
    time.sleep(30)
finally:
    # 永远走不到这里：SIGTERM 会直接终止解释器。留着是为了让人一眼看出这是故意的。
    sys.exit(0)
