# or_figma_bridge.py - WebSocket / HTTP bridge between OR Agent / Chrome Extension and Figma Desktop
import asyncio
import json
import sys

try:
    import websockets
except ImportError:
    print("websockets library not installed, running fallback echo")
    sys.exit(0)

PORT = 9878
connected_figma = set()
pending_requests = {}
req_counter = 0

async def handler(websocket):
    global req_counter
    connected_figma.add(websocket)
    print(f"[OR Figma Bridge] Figma client connected on ws://127.0.0.1:{PORT}")
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                req_id = data.get("id")
                if req_id and req_id in pending_requests:
                    future = pending_requests.pop(req_id)
                    if not future.done():
                        future.set_result(data)
            except Exception as e:
                print(f"[OR Figma Bridge] Error parsing message: {e}")
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_figma.discard(websocket)
        print("[OR Figma Bridge] Figma client disconnected")

async def main():
    async with websockets.serve(handler, "127.0.0.1", PORT):
        print(f"[OR Figma Bridge] Listening on ws://127.0.0.1:{PORT}")
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
