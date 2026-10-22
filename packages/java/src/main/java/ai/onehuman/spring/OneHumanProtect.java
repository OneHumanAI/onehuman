// SPDX-License-Identifier: Apache-2.0
package ai.onehuman.spring;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/** Spring MVC: decide for {@link #value()} before the handler runs. Block → 403, step-up → 428 with the Node middleware's body. */
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface OneHumanProtect {
    String value();
    boolean respond() default true;
    boolean wantToken() default false;
}
