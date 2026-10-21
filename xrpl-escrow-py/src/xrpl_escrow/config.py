"""Network settings. This kit runs on the XRP Ledger testnet only."""
import time

from xrpl.clients import WebsocketClient
from xrpl.models.requests import ServerInfo

TESTNET_NETWORK_ID = 1
TESTNET_URLS = ["wss://s.altnet.rippletest.net:51233", "wss://testnet.xrpl-labs.com"]
FAUCET_HOST = "faucet.altnet.rippletest.net"
EXPLORER_TX = "https://testnet.xrpl.org/transactions/"

#: Ripple epoch starts 2000-01-01; CancelAfter and ledger close_time use it.
RIPPLE_EPOCH_OFFSET = 946684800


def now_ripple_time() -> int:
    return int(time.time()) - RIPPLE_EPOCH_OFFSET


class NotTestnetError(RuntimeError):
    pass


def assert_testnet(client: WebsocketClient) -> None:
    """Abort unless the connected server reports the testnet network id."""
    info = client.request(ServerInfo()).result.get("info", {})
    network_id = info.get("network_id")
    if network_id != TESTNET_NETWORK_ID:
        client.close()
        raise NotTestnetError(
            f"refusing to continue: network_id is {network_id if network_id is not None else 'missing'}, "
            f"expected {TESTNET_NETWORK_ID} (testnet)"
        )


def connect_testnet() -> WebsocketClient:
    """Connect to the first reachable testnet server, then check it really is testnet.

    The caller closes the client (``client.close()``) when done.
    """
    last_error: Exception | None = None
    for url in TESTNET_URLS:
        client = WebsocketClient(url, timeout=30)
        try:
            client.open()
        except Exception as err:  # noqa: BLE001 - try the next server
            last_error = err
            continue
        assert_testnet(client)
        return client
    raise ConnectionError(f"could not reach any testnet server ({', '.join(TESTNET_URLS)}): {last_error}")
