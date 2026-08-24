# 大型 Agent 统一入口：python la_main.py --serve  /  --message "你好"
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

def load_manifest():
    from executor import config as cfgmod
    with open(os.path.join(cfgmod.bundle_root(), 'manifest.json'), encoding='utf-8') as f:
        return json.load(f)

def load_config(manifest):
    # 优先级：配置页保存(data/config.json) > 环境变量 > manifest（env: 占位符）
    from executor import config as cfgmod
    cfg = cfgmod.merge_llm_config(manifest, cfgmod.load_file_config(cfgmod.data_root()))
    cfg['tools_dir'] = os.path.join(cfgmod.bundle_root(), 'tools')
    cfg['_bundle_root'] = cfgmod.bundle_root()
    cfg['_data_root'] = cfgmod.data_root()
    return cfg

def main():
    ap = argparse.ArgumentParser(description='大型 Agent 运行入口（LAG 导出物）')
    ap.add_argument('--serve', action='store_true', help='启动 HTTP 服务并打开控制台')
    ap.add_argument('--port', type=int, default=37800, help='HTTP 端口（默认 37800）')
    ap.add_argument('--message', help='CLI 模式：直接运行一条消息')
    args = ap.parse_args()
    if getattr(sys, 'frozen', False) and not args.message and not args.serve:
        # 双击 exe：直接以服务模式启动
        args.serve = True
    manifest = load_manifest()
    config = load_config(manifest)
    from executor.tools import load_tools
    config['_tools'] = load_tools(config['tools_dir'])
    if args.message:
        from executor.engine import run_la
        result = run_la(manifest, config, args.message)
        print(result['content'])
    elif args.serve:
        import webbrowser
        from transports.http_server import serve
        try:
            webbrowser.open('http://localhost:%d' % args.port)
        except Exception:
            pass
        serve(manifest, config, args.port)
    else:
        ap.print_help()

if __name__ == '__main__':
    main()
