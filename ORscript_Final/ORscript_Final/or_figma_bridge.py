# or_figma_bridge.py - Port 9878
import asyncio, json, sys
PORT = 9878
connected = set()
async def handler(ws):
    connected.add(ws)
    try:
        async for msg in ws: pass
    except: pass
    finally: connected.discard(ws)
async def main():
    try:
        import websockets
        async with websockets.serve(handler, "127.0.0.1", PORT):
            await asyncio.Future()
    except: pass
if __name__ == "__main__":
    try: asyncio.run(main())
    except: pass
