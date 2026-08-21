"""
text_utils.py
-------------
Turns http(s):// URLs typed in plain-text user content (currently:
Comment.body) into clickable hyperlinks when rendered, without
opening an XSS hole.

Registered as the Jinja filter `linkify` in app.py:
    {{ comment.body|linkify }}

Security model - this is the important part:
    1. The ENTIRE input is HTML-escaped first via markupsafe.escape().
       Nothing in the original text is ever trusted or passed through
       verbatim, so `<script>`, `onerror=`, etc. in a comment body are
       neutralized exactly like Jinja's normal auto-escaping would do.
    2. Only *after* escaping do we scan the now-safe text for
       http(s):// URL patterns and wrap matches in `<a>` tags that we
       construct ourselves (not copied from user input in any
       unescaped form).
    3. `rel="noopener noreferrer"` on every generated link, and only
       the `http://` / `https://` schemes are ever auto-linked - not
       `javascript:`, `data:`, `vbscript:`, or any other scheme, so a
       comment can't smuggle a script-executing "link".
    4. The result is wrapped in Markup(...) so Jinja doesn't
       re-escape our generated <a> tags - safe specifically because
       everything inside them was either escaped in step 1 or is a
       literal string we wrote ourselves.
"""

import re
from markupsafe import Markup, escape

# http:// or https:// followed by non-whitespace, non-angle-bracket
# characters. Escaping runs first, so by the time this regex sees the
# text, any literal < or > from user input has already become &lt;/&gt;
# - so trailing &lt;/&gt; can never end up inside a matched URL.
_URL_PATTERN = re.compile(r'(https?://[^\s<>"\']+)')


def linkify(text):
    """Escape `text` for safe HTML output, then wrap any http(s)://
    URLs in it with clickable <a> tags. Returns a Markup instance
    (pre-escaped) - use as a Jinja filter, do NOT apply |safe to
    output that hasn't gone through this function.
    """
    if not text:
        return Markup("")

    escaped = str(escape(text))

    def _wrap(match):
        url = match.group(1)
        # Trailing punctuation (".", ",", ")") right after a URL is
        # usually sentence punctuation, not part of the link - strip
        # it from the link but keep it in the visible text.
        trailing = ""
        while url and url[-1] in ".,)!?;:":
            trailing = url[-1] + trailing
            url = url[:-1]
        if not url:
            return match.group(1)
        return f'<a href="{url}" target="_blank" rel="noopener noreferrer">{url}</a>{trailing}'

    linked = _URL_PATTERN.sub(_wrap, escaped)
    return Markup(linked)
