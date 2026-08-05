import math


from qdrant_client.conversions.common_types import get_args_subscribed
from qdrant_client.http import models
from typing import Any

from qdrant_client.local import datetime_utils
from qdrant_client.local.geo import geo_distance
from qdrant_client.local.payload_filters import check_condition
from qdrant_client.local.payload_value_extractor import value_by_key

DEFAULT_SCORE = 0.0
DEFAULT_DECAY_TARGET = 0.0
DEFAULT_DECAY_MIDPOINT = 0.5
DEFAULT_DECAY_SCALE = 1.0


def evaluate_expression(
    expression: models.Expression,
    point_id: models.ExtendedPointId,
    scores: list[dict[models.ExtendedPointId, float]],
    payload: models.Payload,
    has_vector: dict[str, bool],
    defaults: dict[str, Any],
) -> float:
    if isinstance(expression, (float, int)):  # Constant
        return float(expression)

    elif isinstance(expression, str):  # Variable
        return evaluate_variable(expression, point_id, scores, payload, defaults)

    elif isinstance(expression, get_args_subscribed(models.Condition)):
        if check_condition(expression, payload, point_id, has_vector):  # type: ignore
            return 1.0
        return 0.0

    elif isinstance(expression, models.MultExpression):
        factors: list[float] = []

        for expr in expression.mult:
            factor = evaluate_expression(expr, point_id, scores, payload, has_vector, defaults)
            # Return early if any factor is zero
            if factor == 0.0:
                return factor

            factors.append(factor)

        return math.prod(factors)

    elif isinstance(expression, models.SumExpression):
        return sum(
            evaluate_expression(expr, point_id, scores, payload, has_vector, defaults)
            for expr in expression.sum
        )

    elif isinstance(expression, models.NegExpression):
        value = evaluate_expression(
            expression.neg, point_id, scores, payload, has_vector, defaults
        )
        return -value

    elif isinstance(expression, models.AbsExpression):
        return abs(
            evaluate_expression(expression.abs, point_id, scores, payload, has_vector, defaults)
        )

    elif isinstance(expression, models.DivExpression):
        left = evaluate_expression(
            expression.div.left, point_id, scores, payload, has_vector, defaults
        )

        if left == 0.0:
            return left

        right = evaluate_expression(
            expression.div.right, point_id, scores, payload, has_vector, defaults
        )

        if right == 0.0:
            if expression.div.by_zero_default is not None:
                return expression.div.by_zero_default
            raise_non_finite_error(f"{left}/{right}")

        result = left / right
        if math.isfinite(result):
            return result

        raise_non_finite_error(f"{left}/{right}")

    elif isinstance(expression, models.SqrtExpression):
        value = evaluate_expression(
            expression.sqrt, point_id, scores, payload, has_vector, defaults
        )

        if value >= 0:
            return math.sqrt(value)

        raise_non_finite_error(f"√{value}")

    elif isinstance(expression, models.PowExpression):
        base = evaluate_expression(
            expression.pow.base, point_id, scores, payload, has_vector, defaults
        )
        exponent = evaluate_expression(
            expression.pow.exponent, point_id, scores, payload, has_vector, defaults
        )

        # Check for valid input
        if base >= 0 or (base != 0 and exponent.is_integer()):
            try:
                return math.pow(base, exponent)
            except OverflowError:
                pass

        raise_non_finite_error(f"{base}^{exponent}")

    elif isinstance(expression, models.ExpExpression):
        value = evaluate_expression(
            expression.exp, point_id, scores, payload, has_vector, defaults
        )

        try:
            return math.exp(value)
        except OverflowError:
            raise_non_finite_error(f"exp({value})")

    elif isinstance(expression, models.Log10Expression):
        value = evaluate_expression(
            expression.log10, point_id, scores, payload, has_vector, defaults
        )

        if value > 0:
            try:
                return math.log10(value)
            except OverflowError:
                pass

        raise_non_finite_error(f"log10({value})")

    elif isinstance(expression, models.LnExpression):
        value = evaluate_expression(expression.ln, point_id, scores, payload, has_vector, defaults)

        if value > 0:
            try:
                return math.log(value)
            except OverflowError:
                pass

        raise_non_finite_error(f"ln({value})")

    elif isinstance(expression, models.GeoDistance):
        origin = expression.geo_distance.origin
        to = expression.geo_distance.to

        # Get value from payload
        geo_value = try_extract_payload_value(to, payload, defaults)

        if isinstance(geo_value, dict):
            # let this fail if it is not a valid geo point
            destination = models.GeoPoint(**geo_value)
            return geo_distance(origin.lon, origin.lat, destination.lon, destination.lat)

        raise ValueError(
            f"Expected geo point for {to} in the payload and/or in the formula defaults."
        )

    elif isinstance(expression, models.DatetimeExpression):
        # try to parse as datetime
        dt = datetime_utils.parse(expression.datetime)
        if dt is None:
            raise ValueError(f"Expected datetime in supported format for {expression.datetime}")

        return dt.timestamp()

    elif isinstance(expression, models.DatetimeKeyExpression):
        dt_str = try_extract_payload_value(expression.datetime_key, payload, defaults)
        dt = datetime_utils.parse(dt_str)
        if dt is None:
            raise ValueError(
                f"Expected datetime for {expression.datetime_key} in the payload and/or in the formula defaults."
            )

        return dt.timestamp()

    elif isinstance(expression, models.LinDecayExpression):
        x, target, midpoint, scale = evaluate_decay_params(
            expression.lin_decay, point_id, scores, payload, has_vector, defaults
        )

        lambda_factor = (1.0 - midpoint) / scale
        diff = abs(x - target)
        return max(0.0, -lambda_factor * diff + 1.0)

    elif isinstance(expression, models.ExpDecayExpression):
        x, target, midpoint, scale = evaluate_decay_params(
            expression.exp_decay, point_id, scores, payload, has_vector, defaults
        )

        lambda_factor = math.log(midpoint) / scale
        diff = abs(x - target)
        return math.exp(lambda_factor * diff)

    elif isinstance(expression, models.GaussDecayExpression):
        x, target, midpoint, scale = evaluate_decay_params(
            expression.gauss_decay, point_id, scores, payload, has_vector, defaults
        )

        lambda_factor = math.log(midpoint) / (scale * scale)
        diff = x - target
        return math.exp(lambda_factor * diff * diff)

    raise ValueError(f"Unsupported expression type: {type(expression)}")


def evaluate_decay_params(
    params: models.DecayParamsExpression,
    point_id: models.ExtendedPointId,
    scores: list[dict[models.ExtendedPointId, float]],
    payload: models.Payload,
    has_vector: dict[str, bool],
    defaults: dict[str, Any],
) -> tuple[float, float, float, float]:
    x = evaluate_expression(params.x, point_id, scores, payload, has_vector, defaults)

    if params.target is None:
        target = DEFAULT_DECAY_TARGET
    else:
        target = evaluate_expression(
            params.target, point_id, scores, payload, has_vector, defaults
        )

    midpoint = params.midpoint if params.midpoint is not None else DEFAULT_DECAY_MIDPOINT

    if midpoint <= 0.0 or midpoint >= 1.0:
        raise ValueError(f"Midpoint must be between 0 and 1, got {midpoint}")

    scale = params.scale if params.scale is not None else DEFAULT_DECAY_SCALE
    if scale <= 0.0:
        raise ValueError(f"Scale must be non-zero positive, got {scale}")

    return x, target, midpoint, scale


def try_extract_payload_value(key: str, payload: models.Payload, defaults: dict[str, Any]) -> Any:
    # Get value from payload
    value = value_by_key(payload, key)

    if value is None or len(value) == 0:
        # Or from defaults
        value = defaults.get(key, None)
        # Consider it None if it is an empty list
        if isinstance(value, list) and len(value) == 0:
            value = None

    # Consider it a single value if it's a list with one element
    if isinstance(value, list) and len(value) == 1:
        return value[0]

    if value is None:
        raise ValueError(f"No value found for {key} in the payload nor the formula defaults")

    return value


def evaluate_variable(
    variable: str,
    point_id: models.ExtendedPointId,
    scores: list[dict[models.ExtendedPointId, float]],
    payload: models.Payload,
    defaults: dict[str, Any],
) -> float:
    var = parse_variable(variable)
    if isinstance(var, str):
        value = try_extract_payload_value(var, payload, defaults)

        if is_number(value):
            return value

        raise ValueError(
            f"Expected number value for {var} in the payload and/or in the formula defaults. Error: Value is not a number"
        )

    elif isinstance(var, int):
        # Get score from scores
        score = None
        if var < len(scores):
            score = scores[var].get(point_id, None)
            if score is not None:
                return score

        defined_default = defaults.get(variable, None)
        if defined_default is not None:
            return defined_default

        return DEFAULT_SCORE

    raise ValueError(f"Invalid variable type: {type(var)}")


def parse_variable(var: str) -> str | int:
    # Try to parse score pattern
    if not var.startswith("$score"):
        # Treat as payload path
        return var

    remaining = var.replace("$score", "", 1)
    if remaining == "":
        # end of string, default idx is 0
        return 0

    # it must proceed with brackets
    if not remaining.startswith("["):
        raise ValueError(f"Invalid score pattern: {var}")

    remaining = remaining.replace("[", "", 1)
    bracket_end = remaining.find("]")
    if bracket_end == -1:
        raise ValueError(f"Invalid score pattern: {var}")

    # try parsing the content in between brackets as integer
    try:
        idx = int(remaining[:bracket_end])
    except ValueError:
        raise ValueError(f"Invalid score pattern: {var}")

    # make sure the string ends after the closing bracket
    if len(remaining) > bracket_end + 1:
        raise ValueError(f"Invalid score pattern: {var}")

    return idx


def raise_non_finite_error(expression: str) -> None:
    raise ValueError(f"The expression {expression} produced a non-finite number")


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def test_parsing_variable() -> None:
    assert parse_variable("$score") == 0
    assert parse_variable("$score[0]") == 0
    assert parse_variable("$score[1]") == 1
    assert parse_variable("$score[2]") == 2

    try:
        parse_variable("$score[invalid]")
        assert False
    except ValueError as e:
        assert str(e) == "Invalid score pattern: $score[invalid]"

    try:
        parse_variable("$score[10].other")
        assert False
    except ValueError as e:
        assert str(e) == "Invalid score pattern: $score[10].other"


def test_try_extract_payload_value() -> None:
    for payload_value, expected in [(1.2, 1.2), ([1.2], 1.2), ([1.2, 2.3], [1.2, 2.3])]:
        empty_defaults: dict[str, Any] = {}

        payload = {"key": payload_value}
        assert try_extract_payload_value("key", payload, empty_defaults) == expected

        defaults = {"key": payload_value}
        empty_payload: dict[str, Any] = {}
        assert try_extract_payload_value("key", empty_payload, defaults) == expected
