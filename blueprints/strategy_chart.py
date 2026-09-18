"""
Strategy Chart Blueprint.

UI-only endpoint used by the Strategy Builder's Strategy Chart tab to fetch
the historical combined premium time series for the user's current leg set.
Session-authed, not exposed under /api/v1/.
"""

import os

from flask import Blueprint, jsonify, request, session
from flask_cors import cross_origin
from marshmallow import ValidationError

from database.auth_db import get_api_key_for_tradingview, get_auth_token
from database.settings_db import get_analyze_mode
from limiter import limiter
from restx_api.schemas import OrderSchema
from services.orderbook_service import get_orderbook_with_auth
from services.place_order_service import place_order_with_auth
from services.positionbook_service import get_positionbook_with_auth
from services.intervals_service import get_intervals
from services.multi_strike_oi_service import get_multi_strike_oi_data
from services.strategy_chart_service import get_strategy_chart_data
from utils.logging import get_logger
from utils.session import check_session_validity

logger = get_logger(__name__)

strategy_chart_bp = Blueprint("strategy_chart_bp", __name__, url_prefix="/")

STRATEGY_CHART_LIMIT = os.getenv("STRATEGY_CHART_LIMIT", "30 per minute")

# Upper bound for the `days` lookback. The UI offers at most ten.
MAX_DAYS = 30
INDICATOR_ORDER_LIMIT = os.getenv("INDICATOR_ORDER_LIMIT", "10 per second")


def _indicator_session():
    """Return the broker session used by the chart signal execution boundary."""
    username = session.get("user")
    broker = session.get("broker")
    if not username or not broker:
        return None, None, (jsonify({"status": "error", "message": "Authentication required"}), 401)
    auth_token = get_auth_token(username)
    if not auth_token:
        return None, None, (jsonify({"status": "error", "message": "Broker authentication required"}), 401)
    return auth_token, broker, None


@strategy_chart_bp.route("/trading/api/indicator-order", methods=["POST"])
@check_session_validity
@limiter.limit(INDICATOR_ORDER_LIMIT)
def indicator_order():
    """Place one chart-indicator order without exposing an OpenAlgo API key."""
    try:
        # Analyze/Paper is intentionally resolved before any broker call. The
        # chart only reports the simulated action; it must not create a sandbox
        # or live broker order as a side effect of a paper signal.
        if get_analyze_mode():
            return jsonify(
                {
                    "status": "success",
                    "mode": "analyze",
                    "order_status": "paper",
                    "message": "Indicator order simulated",
                }
            ), 200

        auth_token, broker, error = _indicator_session()
        if error:
            return error

        body = request.get_json(silent=True) or {}
        allowed = {
            "strategy",
            "symbol",
            "exchange",
            "action",
            "quantity",
            "pricetype",
            "product",
            "price",
            "trigger_price",
            "disclosed_quantity",
        }
        payload = {key: body[key] for key in allowed if key in body}
        # OrderSchema is reused as the single source of truth for exchange,
        # product, side, price-type, and quantity validation. A sentinel API
        # key satisfies that schema and is discarded before the broker path.
        validated = OrderSchema().load({"apikey": "session-auth", **payload})
        validated.pop("apikey", None)
        original = dict(validated)
        _success, response, status_code = place_order_with_auth(
            order_data=validated,
            auth_token=auth_token,
            broker=broker,
            original_data=original,
            force_live=True,
        )
        return jsonify(response), status_code
    except ValidationError as exc:
        return jsonify({"status": "error", "message": str(exc.messages)}), 400
    except Exception as exc:
        logger.exception("Error placing chart indicator order: %s", exc)
        return jsonify({"status": "error", "message": "Indicator order failed"}), 500


@strategy_chart_bp.route("/trading/api/indicator-positions", methods=["GET"])
@check_session_validity
def indicator_positions():
    """Read live positions for the indicator execution bridge."""
    try:
        if get_analyze_mode():
            return jsonify({"status": "success", "mode": "analyze", "data": []}), 200
        auth_token, broker, error = _indicator_session()
        if error:
            return error
        _success, response, status_code = get_positionbook_with_auth(auth_token, broker)
        return jsonify(response), status_code
    except Exception as exc:
        logger.exception("Error reading chart indicator positions: %s", exc)
        return jsonify({"status": "error", "message": "Unable to read positions"}), 500


@strategy_chart_bp.route("/trading/api/indicator-order-status", methods=["POST"])
@check_session_validity
def indicator_order_status():
    """Verify a live indicator order through the server-side broker session."""
    try:
        auth_token, broker, error = _indicator_session()
        if error:
            return error
        body = request.get_json(silent=True) or {}
        orderid = str(body.get("orderid") or "").strip()
        if not orderid:
            return jsonify({"status": "error", "message": "orderid is required"}), 400

        # This is deliberately a direct broker-session read rather than the
        # public order-status service. If the operator switches the global mode
        # after a live order is accepted, the already-issued live order must
        # still be verified against the live broker book, not the paper sandbox.
        _success, orderbook, status_code = get_orderbook_with_auth(auth_token, broker)
        if orderbook.get("status") != "success":
            return jsonify(orderbook), status_code
        raw = orderbook.get("data", {})
        orders = raw.get("orders", []) if isinstance(raw, dict) else raw
        found = next(
            (order for order in orders if str(order.get("orderid")) == orderid),
            None,
        ) if isinstance(orders, list) else None
        if found is None:
            return jsonify({"status": "error", "message": "Order not found"}), 404
        return jsonify({"status": "success", "data": found}), 200
    except Exception as exc:
        logger.exception("Error verifying chart indicator order: %s", exc)
        return jsonify({"status": "error", "message": "Unable to verify order status"}), 500


@strategy_chart_bp.route("/strategybuilder/api/strategy-chart", methods=["POST"])
@cross_origin()
@check_session_validity
@limiter.limit(STRATEGY_CHART_LIMIT)
def strategy_chart_data():
    """Get the combined premium time series for a user-built strategy."""
    try:
        broker = session.get("broker")
        if not broker:
            return jsonify({"status": "error", "message": "Broker not set in session"}), 400

        login_username = session["user"]
        auth_token = get_auth_token(login_username)
        if auth_token is None:
            return jsonify({"status": "error", "message": "Authentication required"}), 401

        api_key = get_api_key_for_tradingview(login_username)
        if not api_key:
            return jsonify(
                {
                    "status": "error",
                    "message": "API key not configured. Please generate an API key in /apikey",
                }
            ), 401

        data = request.get_json(silent=True) or {}
        underlying = (data.get("underlying") or "").strip()
        exchange = (data.get("exchange") or "").strip()
        underlying_symbol = (data.get("underlying_symbol") or "").strip() or None
        underlying_exchange = (data.get("underlying_exchange") or "").strip() or None
        interval = (data.get("interval") or "5m").strip()
        try:
            days = int(data.get("days", 3))
        except (TypeError, ValueError):
            days = 3
        # Clamped, because `days` sizes a calendar window as `days * 3 + 2` and
        # every request fans out into one broker call per leg. The control that
        # feeds it only ever offered single digits; an unbounded value from a
        # crafted body would turn one click into years of history per leg.
        days = max(1, min(days, MAX_DAYS))
        # An explicit window, sent by a chart paging older history. Counting
        # back from today cannot express "the fortnight before what I already
        # have", which is what scrolling left asks for.
        start_date = (data.get("start_date") or "").strip() or None
        end_date = (data.get("end_date") or "").strip() or None
        legs = data.get("legs") or []

        if not underlying or not exchange:
            return jsonify(
                {"status": "error", "message": "underlying and exchange are required"}
            ), 400
        if not isinstance(legs, list) or len(legs) == 0:
            return jsonify(
                {"status": "error", "message": "At least one leg is required"}
            ), 400

        success, response, status_code = get_strategy_chart_data(
            underlying=underlying,
            exchange=exchange,
            legs=legs,
            interval=interval,
            api_key=api_key,
            days=days,
            underlying_symbol=underlying_symbol,
            underlying_exchange=underlying_exchange,
            start_date=start_date,
            end_date=end_date,
        )
        return jsonify(response), status_code

    except Exception as e:
        logger.exception(f"Error in strategy chart API: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@strategy_chart_bp.route("/strategybuilder/api/multi-strike-oi", methods=["POST"])
@cross_origin()
@check_session_validity
@limiter.limit(STRATEGY_CHART_LIMIT)
def multi_strike_oi_data():
    """Get per-leg OI time series alongside the underlying price."""
    try:
        broker = session.get("broker")
        if not broker:
            return jsonify({"status": "error", "message": "Broker not set in session"}), 400

        login_username = session["user"]
        auth_token = get_auth_token(login_username)
        if auth_token is None:
            return jsonify({"status": "error", "message": "Authentication required"}), 401

        api_key = get_api_key_for_tradingview(login_username)
        if not api_key:
            return jsonify(
                {
                    "status": "error",
                    "message": "API key not configured. Please generate an API key in /apikey",
                }
            ), 401

        data = request.get_json(silent=True) or {}
        underlying = (data.get("underlying") or "").strip()
        exchange = (data.get("exchange") or "").strip()
        underlying_symbol = (data.get("underlying_symbol") or "").strip() or None
        underlying_exchange = (data.get("underlying_exchange") or "").strip() or None
        interval = (data.get("interval") or "5m").strip()
        try:
            days = int(data.get("days", 3))
        except (TypeError, ValueError):
            days = 3
        # Clamped, because `days` sizes a calendar window as `days * 3 + 2` and
        # every request fans out into one broker call per leg. The control that
        # feeds it only ever offered single digits; an unbounded value from a
        # crafted body would turn one click into years of history per leg.
        days = max(1, min(days, MAX_DAYS))
        # An explicit window, sent by a chart paging older history. Counting
        # back from today cannot express "the fortnight before what I already
        # have", which is what scrolling left asks for.
        start_date = (data.get("start_date") or "").strip() or None
        end_date = (data.get("end_date") or "").strip() or None
        legs = data.get("legs") or []

        if not underlying or not exchange:
            return jsonify(
                {"status": "error", "message": "underlying and exchange are required"}
            ), 400
        if not isinstance(legs, list) or len(legs) == 0:
            return jsonify(
                {"status": "error", "message": "At least one leg is required"}
            ), 400

        success, response, status_code = get_multi_strike_oi_data(
            underlying=underlying,
            exchange=exchange,
            legs=legs,
            interval=interval,
            api_key=api_key,
            days=days,
            underlying_symbol=underlying_symbol,
            underlying_exchange=underlying_exchange,
            start_date=start_date,
            end_date=end_date,
        )
        return jsonify(response), status_code

    except Exception as e:
        logger.exception(f"Error in multi-strike OI API: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@strategy_chart_bp.route("/strategybuilder/api/intervals", methods=["GET"])
@cross_origin()
@check_session_validity
def strategy_chart_intervals():
    """Proxy broker-supported intervals for the Strategy Chart tab."""
    try:
        login_username = session.get("user")
        if not login_username:
            return jsonify({"status": "error", "message": "Authentication required"}), 401

        api_key = get_api_key_for_tradingview(login_username)
        if not api_key:
            return jsonify({"status": "error", "message": "API key not configured"}), 401

        _, response, status_code = get_intervals(api_key=api_key)
        return jsonify(response), status_code

    except Exception as e:
        logger.exception(f"Error fetching intervals: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500
